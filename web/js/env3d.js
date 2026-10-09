// env3d.js — environment / atmosphere layer of the 3D view.
//
// Owns everything that is *behind* gameplay: the procedural deep-space sky
// (nebulae, dust lanes, galaxy band, the sector's sun), the instanced star
// field (which stretches into hyperspace streaks), real 3D planets (surfaces
// baked into cube maps once per sector: gas giants, rocky / desert / ocean /
// ice / lava worlds, rings, moons, clouds, city lights, aurorae), drifting fog
// sheets that are lit by the game's dynamic lights, parallax dust motes, the
// lane (depth cue on the play plane), weather (ion-storm lightning, eclipse)
// and a scheduler of rare far-away ambient events (comets and comet strikes,
// meteor showers, fleet engagements, convoys, a capital ship under the lane,
// stations, solar flares, novae, pulsars, nebula lightning, jump gates, …).
//
// Conventions: play plane = XZ at y=0, +X forward, world units = sim pixels.
// Nothing here writes depth; everything renders before gameplay (negative
// renderOrder, see RO below). THREE is injected — no imports.
//
// Integration notes:
//  * opts.renderer (or the first frame that draws the sky) binds the WebGLRenderer. The baked
//    planet cube maps are render targets: on `webglcontextrestored` of renderer.domElement the
//    environment re-bakes them by itself (rebake()); call env.rebake() yourself only if you
//    restore a context by other means. A context lost in the middle of a bake is harmless.
//  * First impression: the planet the camera is looking at is baked synchronously inside the
//    first update() and shown without a fade; a setSector() issued before anything was drawn
//    replaces the sector at once instead of crossfading. To move even that cost behind a
//    loading / start screen call env.prewarm(renderer) (everything, one hitch) or
//    env.prewarm(renderer, 300000) once per frame until it returns true (env.bakeProgress 0…1).
//  * Far hulls (shipsMesh / rocksMesh) are the ONE exception to "nothing writes depth": they
//    resolve their own occlusion in the last sliver of the depth range (NDC z ≥ 0.9997, i.e.
//    behind anything nearer than ~16 000 units), so they cannot hide gameplay.
//    opts.shipDepth = false restores pure painter's order.
//
// Readability: every layer is multiplied by a "field mask" — the part of the
// backdrop that is seen *through* the play field gets dimmed — so the sky can
// be rich at the horizon and the edges while staying dark behind the bullets.

const MAXL = 16;
const SCROLL = 140; // world drift, units/s at speedMul = warpMul = 1

// render order (all negative: gameplay uses 0, particles 20–23)
const RO = {
  sky: -100, stars: -96,
  planet: -90,   // -90 … -61, re-sorted by camera distance (halo, body, ring, moon)
  ship: -54,     // far hulls / rocks of ambient events
  comet: -52,
  blip: -50,     // event lights
  fog: -40,      // -40 … -38 (deepest sheet first)
  lane: -20,
  bolt: -12,
  dust: -8,
};

function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const NOOPTS = Object.freeze({});
const BAKE_ORDER_T = [0, 4, 5, 2, 1, 3], BAKE_ORDER_H = [1, 4, 5, 3, 0, 2];
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v) => v * v * (3 - 2 * v);

/* ------------------------------- GLSL chunks ------------------------------- */

const G_NOISE = /* glsl */`
uniform highp sampler3D uNoise;
float n3(vec3 p){ vec3 i=floor(p); vec3 f=fract(p); f=f*f*(3.-2.*f); return texture(uNoise,(i+f+.5)*.03125).r; }
vec4 n4(vec3 p){ vec3 i=floor(p); vec3 f=fract(p); f=f*f*(3.-2.*f); return texture(uNoise,(i+f+.5)*.03125); }
float fbm(vec3 p){ float a=.5,s=0.; for(int i=0;i<OCT;i++){ s+=a*n3(p); p=p*2.03+vec3(7.1,3.3,5.7); a*=.5; } return s; }
float fbmF(vec3 p){ float a=.5,s=0.; for(int i=0;i<FOCT;i++){ s+=a*n3(p); p=p*2.03+vec3(7.1,3.3,5.7); a*=.5; } return s/(1.-pow(.5,float(FOCT)))*.9375; }
float fbm2(vec3 p){ return n3(p)*.62+n3(p*2.11+vec3(3.7,9.2,1.3))*.38; }
`;

// how much of this view ray passes through the play field (0 outside … 1 inside)
const G_MASK = /* glsl */`
float sq(float x){ return x*x; }
uniform vec3 uCam;
uniform vec4 uField; // halfW, halfH, dim strength, -
float fieldMask(vec3 ro, vec3 rd){
  if(rd.y>-1e-4||ro.y<=0.) return 0.;
  vec2 h=ro.xz+rd.xz*(ro.y/-rd.y);
  float mx=1.-smoothstep(-220.,220.,max(-uField.x-120.-h.x,h.x-uField.x-420.));
  float mz=1.-smoothstep(-130.,130.,abs(h.y)-uField.y);
  return mx*mz;
}
// 0 in the middle of the play field … 1 at its rim: big soft shapes may get some presence back there
float fieldRim(vec3 ro, vec3 rd){
  if(rd.y>-1e-4||ro.y<=0.) return 1.;
  vec2 c=abs(ro.xz+rd.xz*(ro.y/-rd.y))/uField.xy;
  return smoothstep(.38,1.02,max(c.x*.92,c.y));
}
`;

const G_LIGHTS = /* glsl */`
uniform vec4 uLP[${MAXL}];
uniform vec4 uLC[${MAXL}];
uniform int uLN;
uniform vec4 uFlashP;
uniform vec3 uFlashC;
vec3 dynLight(vec3 wp,float spread,float yb){
  vec3 s=vec3(0.);
  for(int i=0;i<NL;i++){
    if(i>=uLN) break;
    vec3 d=wp-uLP[i].xyz; d.y*=yb;
    float R=uLP[i].w*spread+50.;
    float w=max(0.,1.-dot(d,d)/(R*R));
    s+=uLC[i].rgb*(w*w*w);
  }
  vec3 d=wp-uFlashP.xyz; d.y*=yb;
  float w=max(0.,1.-dot(d,d)/(uFlashP.w*uFlashP.w));
  return s+uFlashC*(w*w);
}
`;

const G_END = /* glsl */`
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;

/* ---------------------------------- sky ----------------------------------- */

const SKY_VS = /* glsl */`
varying vec3 vDir;
void main(){
  vDir=position;
  vec4 p=projectionMatrix*vec4(mat3(viewMatrix)*position,0.);
  gl_Position=vec4(p.xy,p.w*.9999,p.w);
}`;

const SKY_FS = /* glsl */`
${G_NOISE}${G_MASK}
varying vec3 vDir;
uniform vec3 uBase,uNebA,uNebB,uNebC,uGalCol,uHaze,uSeed,uGalN;
uniform float uNebAmt,uTime,uWarp,uWarpT,uEclipse,uIon,uDip;
uniform vec3 uSunDir,uSunT,uSunB,uSunCol,uSun2Dir,uSun2Col,uSkyFlash;
uniform vec4 uSun; // angular radius, intensity, companion radius, companion intensity
uniform vec4 uFlare; // limb angle, amount, loop size, jet
uniform vec4 uGlowD,uGlowD2; uniform vec3 uGlowC,uGlowC2; // nebula lightning / nova light: direction + sharpness, colour
// A star: photosphere with limb darkening, granulation and spots, a thin chromosphere with
// spicules, corona streamers, diffraction spikes — and, during a flare, a prominence arch
// that grows off the limb and tears open. The disc is deliberately NOT blown out: it has to
// stay below the bloom's "everything is white" range for any of this to read.
vec3 sunTerm(vec3 d,vec3 sd,vec3 sc,float r,float ecl,float spk,float fl,float seed){
  float c=dot(d,sd); float a=sqrt(max(0.,2.-2.*c));
  vec3 rel=d-sd;
  float u=dot(rel,uSunT),v=dot(rel,uSunB);
  vec2 p=vec2(u,v)/r; float q=a/r;
  vec2 dn=p/max(length(p),1e-5);
  float g3=exp(-a*2.8);
  float spike=(exp(-abs(v)/(r*.06))*exp(-abs(u)/(r*3.5))+exp(-abs(u)/(r*.06))*exp(-abs(v)/(r*2.2)))*spk;
  vec3 hot=mix(sc,vec3(1.),.6);
  vec3 col=sc*(g3*.03*(1.-.6*ecl))+hot*(spike*.55*(1.-ecl));
  if(q>40.) return col;
  float outD=smoothstep(.9,1.08,q);                     // 0 on the disc, 1 outside
  // corona: long streamers + fine striations close to the limb
  float s1=n3(vec3(dn*2.6,uTime*.025+seed)), s2=n3(vec3(dn*7.+9.,uTime*.04+seed));
  float stream=s1*s1*s1*1.9+s2*s2*s2*s2*1.1;
  float fine=n3(vec3(dn*23.,uTime*.07+seed*2.));
  float g1=exp(-a/(r*1.25))*mix(.3,1.,outD);
  float g2=exp(-a/(r*4.))*(.14+.72*stream);
  float gf=exp(-max(q-1.,0.)*1.9)*outD*(.25+.75*fine*fine)*.5;
  float ring=exp(-sq((q-1.03)/.13));
  // photosphere
  vec3 disc=vec3(0.);
  if(q<1.06){
    float qc=min(q,1.); float mu=sqrt(1.-qc*qc);
    vec3 sph=vec3(p,mu);
    float gr=n3(sph*8.+vec3(uTime*.03,seed,uTime*.02))*.55+n3(sph*19.+vec3(seed,uTime*.06,3.))*.45;
    float fac=smoothstep(.6,.8,n3(sph*3.1+vec3(seed*2.,uTime*.006,5.)));          // bright faculae
    float spot=smoothstep(.74,.8,n3(sph*2.3+vec3(seed*3.,1.,uTime*.004)))*smoothstep(.25,.6,mu);
    float ld=.3+.7*pow(mu,.55);
    vec3 pc=mix(sc*vec3(1.,.72,.5),hot,smoothstep(0.,.75,mu));                    // the limb is cooler
    disc=pc*(ld*(.78+.46*gr+.25*fac*(1.-mu))*(1.-.6*spot)*1.9)*smoothstep(1.035,.985,q);
  }
  // chromosphere: a thin coloured rim with spicules and a few small standing prominences
  vec3 chromC=mix(sc,vec3(1.,.3,.22),.6);
  float sp1=n3(vec3(dn*6.,seed+uTime*.03)), sp2=n3(vec3(dn*31.,uTime*.25+seed));
  float chrom=exp(-sq((q-1.015)/.028))*(.55+.6*sp2)
            +pow(sp1,5.)*exp(-max(q-1.,0.)/(.05+.16*sp1))*outD*2.2*(.5+.7*sp2);
  float prom=0.,kern=0.;
  if(fl>0.&&q<5.5){   // the flare: nested arches anchored on the limb, plasma running along them, then a jet
    vec2 cd=vec2(cos(uFlare.x),sin(uFlare.x));
    float al=dot(p,cd)-.97, ac=p.x*cd.y-p.y*cd.x;
    float W=uFlare.z*.55, H=uFlare.z*(.45+1.05*fl);
    float above=smoothstep(-.02,.06,al)*smoothstep(.93,1.01,q)*(1.-smoothstep(4.2,5.4,q));
    float phi=atan(al/H,ac/W);
    for(int i=0;i<3;i++){
      float k=1.-.2*float(i);
      float e=length(vec2(ac/(W*k),al/(H*k)));
      float wob=(n3(vec3(phi*2.2,uTime*.5+float(i)*3.,e*2.))-.5)*.13;
      float th=.07+.035*float(i);
      float fil=.25+1.3*n3(vec3(phi*3.5-uTime*(1.3-.3*float(i)),float(i)*5.+seed,e*3.));
      prom+=exp(-sq((e-1.+wob)/th))*fil*(1.-.22*float(i));
    }
    prom*=above*fl;
    float jw=.05+.16*max(al,0.);
    float jet=exp(-sq(ac/jw))*exp(-max(al,0.)*(1.9-1.2*fl))*smoothstep(0.,.1,al)*uFlare.w
             *(.3+1.2*n3(vec3(al*4.-uTime*2.2,ac*9.,seed)))*smoothstep(.45,1.,fl);
    prom+=jet*1.4*smoothstep(.93,1.01,q);
    kern=(exp(-(sq(ac-W)+al*al)*90.)+exp(-(sq(ac+W)+al*al)*90.))*fl;      // footpoints flash
  }
  if(fl>0.){ vec2 cd=vec2(cos(uFlare.x),sin(uFlare.x)); g2*=1.+.5*fl; gf*=1.+1.5*fl*exp(-dot(p-cd,p-cd)*1.2); }
  col+=disc*(1.-ecl)
     + sc*(g1*.9*(1.-.75*ecl)+(g2*.34+gf)*(1.+1.2*ecl)+ring*ecl*2.6)
     + chromC*(chrom*.9*(1.-.3*ecl))
     + mix(vec3(1.,.2,.16),sc,.22)*(prom*5.5)+hot*(kern*3.);
  return col;
}
void main(){
  vec3 d=normalize(vDir);
  vec3 q=d*1.7+uSeed;
  vec4 w=n4(q*1.3+11.);
  vec3 qq=q+(w.gba-.5)*1.15;
  float f=fbm(qq*1.45);
  float neb=smoothstep(.40,.74,f);
#ifdef LITE
  float mixk=smoothstep(.32,.68,w.r);
  float lanes=smoothstep(.55,.75,w.a)*.8;
#else
  float mixk=smoothstep(.32,.68,n3(q*.9+4.)*.6+w.r*.4);
  float lanes=smoothstep(.50,.70,fbm2(qq*2.7+31.));
#endif
  vec3 col=uBase*(.55+.9*w.g);
  col+=mix(uNebA,uNebB,mixk)*neb*(1.-.85*lanes)*(.55+.9*f)*uNebAmt;
  col+=uNebC*neb*neb*neb*smoothstep(.5,.85,w.b)*(1.-lanes)*uNebAmt;
  float gb=dot(d,uGalN);
  col+=uGalCol*exp(-gb*gb*42.)*(.3+1.1*f)*(1.-.9*lanes)*uDip;
  float hz=exp(-abs(d.y)*10.);
  col+=uHaze*hz*(.45+.7*w.r);
  col*=1.-.5*uEclipse;
  col+=vec3(.004,.012,.03)*uIon*(.3+w.g+neb);
  vec3 sun=sunTerm(d,uSunDir,uSunCol,uSun.x,uEclipse,1.,uFlare.y,uSeed.x)*uSun.y*.6; // trimmed: the glare sat on top of the HUD and the far lane
  if(uSun.w>0.) sun+=sunTerm(d,uSun2Dir,uSun2Col,uSun.z,uEclipse*.4,.6,0.,uSeed.y+5.)*uSun.w;
  col+=sun*uDip;
  col+=uSkyFlash*(.25+1.3*f);
  float fmS=fieldMask(uCam,d);
  if(uGlowC.r+uGlowC.g+uGlowC.b+uGlowC2.r+uGlowC2.g+uGlowC2.b>1e-4){
    // light from inside the clouds: thick gas glows, the dust lanes in front stay dark and get a bright edge
    float body=neb*(1.5-.9*lanes)+.1+.55*f+smoothstep(.3,.5,f)*(1.-neb)*.5;
    float edge=lanes*(1.-lanes)*2.2*neb;
    vec3 gl=uGlowC*exp((dot(d,uGlowD.xyz)-1.)*uGlowD.w)+uGlowC2*exp((dot(d,uGlowD2.xyz)-1.)*uGlowD2.w);
    col+=gl*(body+edge)*(1.-.85*fmS);
  }
#ifdef WARP
  if(uWarp>.003){
    float r=length(d.yz); vec2 a=d.yz/max(r,1e-4);
    float s1=n3(vec3(a*8.,d.x*1.6-uWarpT*.9));
    float s2=n3(vec3(a*21.+5.,d.x*3.2-uWarpT*1.7));
    float st=s1*s1*s1*.9+s2*s2*s2*s2*1.5;
    float rim=smoothstep(.03,.55,r);
    vec3 wc=mix(vec3(.16,.34,1.),vec3(.75,.9,1.2),s2);
    float core=exp(-r*r*16.)*step(0.,d.x);
    col=col*(1.-.45*uWarp)+(wc*st*rim*.3+vec3(.5,.72,1.)*core*.6)*uWarp;
  }
#endif
  col*=1.-uField.z*fmS;
  gl_FragColor=vec4(col,1.);
  ${G_END}
}`;

/* --------------------------------- stars ---------------------------------- */

const STAR_VS = /* glsl */`
${G_MASK}
attribute vec3 aDir;
attribute vec4 aData; // half-size px, phase, rank, glint
attribute vec3 aCol;
uniform mat3 uRot;
uniform float uStreak,uPx,uAspect,uTime,uCount,uBright;
varying vec2 vUv; varying vec3 vCol; varying float vLen; varying float vGl;
void main(){
  vec3 d=uRot*aDir;
  vec4 c0=projectionMatrix*vec4(mat3(viewMatrix)*d,0.);
  if(c0.w<=1e-4||aData.z>uCount){ gl_Position=vec4(2.,2.,2.,1.); return; }
  vec3 m=vec3(-1.,0.,0.)+d*d.x;
  vec3 d2=normalize(d+m*uStreak*(.35+.65*fract(aData.y*7.31)));
  vec4 c1=projectionMatrix*vec4(mat3(viewMatrix)*d2,0.);
  vec2 asp=vec2(uAspect,1.);
  vec2 A=c0.xy/c0.w*asp;
  vec2 B=c1.w>1e-4?c1.xy/c1.w*asp:A;
  vec2 ax=B-A; float len=length(ax);
  vec2 dir=len>1e-5?ax/len:vec2(1.,0.);
  float gl=aData.w*(1.-smoothstep(0.,.02,uStreak));
  float sz=aData.x*uPx*(1.+5.*gl);
  vec2 p=mix(A,B,position.x*.5+.5)+dir*position.x*sz+vec2(-dir.y,dir.x)*position.y*sz;
  gl_Position=vec4(p/asp,.999,1.);
  vUv=position.xy; vLen=len/sz; vGl=gl;
  float tw=1.+.28*sin(uTime*(1.2+3.*fract(aData.y*3.7))+aData.y*6.283);
  float sn=clamp(uStreak*6.,0.,1.);
  vec3 c=mix(aCol,vec3(.55,.75,1.25)*(dot(aCol,vec3(.33))+.25),sn*.7);
  vCol=c*tw*uBright*(1.-mix(uField.z,.93,aData.w)*fieldMask(uCam,d))/(1.+vLen*.12); // no glint stars behind the bullets
}`;

const STAR_FS = /* glsl */`
varying vec2 vUv; varying vec3 vCol; varying float vLen; varying float vGl;
void main(){
  float ax=max(abs(vUv.x)*(1.+vLen)-vLen,0.);
  float r2=ax*ax+vUv.y*vUv.y;
  float k=mix(5.5,150.,vGl);
  float b=exp(-r2*k);
  vec2 a=abs(vUv);
  b+=vGl*(exp(-a.y*46.)*exp(-a.x*4.2)+exp(-a.x*46.)*exp(-a.y*4.2))*.45+vGl*exp(-r2*22.)*.07;
  b*=1.-smoothstep(.72,1.,max(r2,max(a.x,a.y)));
  gl_FragColor=vec4(vCol*b,1.);
  ${G_END}
}`;

/* ---------------------------------- dust ---------------------------------- */

const DUST_VS = /* glsl */`
${G_MASK}
attribute vec3 aPos;
attribute vec3 aD; // parallax, brightness, width
uniform vec3 uBox,uAnchor,uDustCol;
uniform float uScroll,uLen,uPx,uAspect,uBright;
varying vec2 vUv; varying vec3 vCol; varying float vLen;
void main(){
  vec3 p=aPos; p.x-=uScroll*aD.x;
  p=mod(p-uAnchor+uBox*.5,uBox)-uBox*.5+uAnchor;
  vec3 p2=p+vec3(uLen*aD.x,0.,0.);
  vec4 c0=projectionMatrix*viewMatrix*vec4(p,1.);
  vec4 c1=projectionMatrix*viewMatrix*vec4(p2,1.);
  if(c0.w<20.||c1.w<20.){ gl_Position=vec4(2.,2.,2.,1.); return; }
  vec2 asp=vec2(uAspect,1.);
  vec2 A=c0.xy/c0.w*asp,B=c1.xy/c1.w*asp;
  vec2 ax=B-A; float len=length(ax);
  vec2 dir=len>1e-6?ax/len:vec2(1.,0.);
  float wpx=aD.z*projectionMatrix[1][1]/c0.w/uPx;       // half-width in px
  float sz=max(wpx,1.1)*uPx;
  vec2 q=mix(A,B,position.x*.5+.5)+dir*position.x*sz+vec2(-dir.y,dir.x)*position.y*sz;
  gl_Position=vec4(q/asp,.5,1.);
  vUv=position.xy; vLen=len/sz;
  vec3 e=uBox*.5-abs(p-uAnchor);
  float edge=smoothstep(0.,300.,e.x)*smoothstep(0.,120.,e.y)*smoothstep(0.,300.,e.z);
  float fade=edge*smoothstep(60.,260.,c0.w)*min(1.,wpx/1.1)*(1.-smoothstep(2600.,5200.,c0.w)*.7);
  vCol=uDustCol*aD.y*uBright*fade*(1.-uField.z*fieldMask(uCam,p-uCam))/(1.+vLen*.035);
}`;

const DUST_FS = /* glsl */`
varying vec2 vUv; varying vec3 vCol; varying float vLen;
void main(){
  float ax=max(abs(vUv.x)*(1.+vLen)-vLen,0.);
  float r2=ax*ax+vUv.y*vUv.y;
  float tail=mix(1.,.25+.75*(vUv.x*.5+.5),clamp(vLen*.2,0.,1.));
  gl_FragColor=vec4(vCol*exp(-r2*4.5)*(1.-smoothstep(.7,1.,r2))*tail,1.);
  ${G_END}
}`;

/* ---------------------------------- fog ----------------------------------- */

const WORLD_VS = /* glsl */`
varying vec3 vW;
void main(){ vec4 w=modelMatrix*vec4(position,1.); vW=w.xyz; gl_Position=projectionMatrix*viewMatrix*w; }`;

const FOG_FS = /* glsl */`
${G_NOISE}${G_MASK}${G_LIGHTS}
varying vec3 vW;
uniform float uScroll,uTime,uPar,uScale,uDens,uIon,uGain,uLayer,uFar,uWarp,uEclipse,uInner;
uniform vec3 uFogCol,uFogCol2,uSeed,uSunDir,uSunCol;
void main(){
  vec3 rd=vW-uCam; float dist=length(rd); vec3 v=rd/dist;
  vec3 q=vec3(vW.x+uScroll*uPar,0.,vW.z)*uScale+uSeed+vec3(0.,uLayer*3.7+uTime*.03,0.);
  q.x*=1./(1.+uWarp*2.5);
  vec4 w=n4(q*.55+7.+vec3(uTime*.011,0.,uTime*.007));
  float f=fbmF(q+vec3(w.g-.5,0.,w.b-.5)*1.5);
  float dens=smoothstep(.36,.78,f);
  float graze=smoothstep(.012,.15,abs(v.y));
  float fade=exp(-dist/uFar)*smoothstep(80.,340.,dist);
  float ex=max(-uField.x-120.-vW.x,vW.x-uField.x-420.);
  float inside=(1.-smoothstep(-200.,160.,ex))*(1.-smoothstep(-160.,160.,abs(vW.z)-uField.y));
  float vis=graze*fade*mix(1.,uInner,inside);
  float a=dens*uDens*vis;
  float ph=.6+.7*pow(max(dot(v,uSunDir),0.),6.);
  vec3 L=mix(uFogCol,uFogCol2,w.r)*ph*(1.-.5*uEclipse);
  L+=uSunCol*pow(max(dot(v,uSunDir),0.),24.)*.03*(1.-uEclipse);
  if(uIon>.01){
    float ridge=1.-abs(2.*n3(q*5.3+vec3(0.,uTime*1.3,0.))-1.);
    float vein=pow(ridge,40.)*smoothstep(.55,.8,sin(uTime*17.+w.a*31.))*smoothstep(.5,.7,w.r);
    L+=vec3(.014,.04,.1)*uIon*(1.+14.*vein);
  }
  L+=vec3(.1,.2,.5)*uWarp*.25;
  vec3 dl=dynLight(vW,1.5,.6)*uGain;
  vec3 col=L*a+dl*(.08+1.3*dens*dens)*graze*fade;
  gl_FragColor=vec4(col,a*.55);
  ${G_END}
}`;

/* ---------------------------------- lane ---------------------------------- */

const LANE_FS = /* glsl */`
${G_MASK}${G_LIGHTS}
varying vec3 vW;
uniform float uScroll,uLane,uTime,uWarp,uIon;
uniform vec3 uRail,uGrid;
void main(){
  float hw=uField.x,hh=uField.y;
  float dist=length(vW-uCam);
  float dz=abs(vW.z)-hh;
  float fz=fwidth(vW.z);
  float core=1.-smoothstep(0.,max(fz*1.3,1.6),abs(dz));
  float glow=exp(-abs(dz)/22.)*.2+exp(-abs(dz)/120.)*.035;
  float sx=vW.x+uScroll;
  float pulse=.7+.3*smoothstep(.0,.5,abs(fract(sx/640.)-.5));
  float chev=smoothstep(.47,.5,abs(fract(sx/640.)-.5));
  float inside=1.-smoothstep(-1.,1.,dz);
  float lz=(vW.z+hh)/(2.*hh)*6.;
  float lw=fwidth(lz);
  float lline=(1.-min(abs(fract(lz+.5)-.5)/lw,1.))*(1.-smoothstep(.15,.5,lw));
  float cx=sx/160.;
  float cw=fwidth(cx);
  float cdist=abs(fract(cx+.5)-.5);
  float cline=(1.-min(cdist/cw,1.))*(1.-smoothstep(.12,.45,cw));
  float major=step(abs(fract(cx*.25+.5)-.5),.13);
  float tick=1.-smoothstep(0.,70.,-dz);
  // dashes on the longitudinal lines instead of a full grid: quieter, still measurable
  float dash=smoothstep(.30,.34,abs(fract(cx+.5)-.5));
  float g=inside*(lline*dash*.34+cline*(.10+.22*major+1.3*tick));
  float xf=smoothstep(-hw-900.,-hw-150.,vW.x)*exp(-max(vW.x-hw,0.)/3200.);
  float near=smoothstep(40.,260.,dist);
  vec3 dl=dynLight(vW,1.7,1.);
  float dlum=dot(dl,vec3(.3,.5,.2));
  vec3 col=uGrid*g*(1.+min(dlum*2.2,5.))+dl*g*.55;
  col+=dl*inside*.012;
  vec3 rail=mix(uRail,vec3(.5,.75,1.4),uIon*.5);
  col+=rail*(core*(.8+chev*1.6)+glow*pulse*.7)*(1.+min(dlum*1.2,2.5));
  col+=rail*glow*uWarp*1.5;
  gl_FragColor=vec4(col*uLane*xf*near,1.);
  ${G_END}
}`;

/* --------------------------------- planets -------------------------------- */
//
// A planet is a sphere that samples two cube maps baked ONCE per sector by
// BAKE_FS (analytic gradient noise, domain warps, craters, vortices — far too
// expensive per frame, free once it is a texture):
//   map A: rgb = sqrt(albedo), a = mask (water / ice sheen, storm cells on gas giants)
//   map B: rg  = surface gradient (bump), b = cloud cover, a = sqrt(emission)
// so the per-frame shader is a handful of cube taps + lighting, no matter how
// much of the screen the planet covers.

const PLANET_VS = /* glsl */`
varying vec3 vW; varying vec3 vN; varying vec3 vO;
void main(){
  vO=position;
  vN=normalize(mat3(modelMatrix)*normal);
  vec4 w=modelMatrix*vec4(position,1.); vW=w.xyz;
  gl_Position=projectionMatrix*viewMatrix*w;
}`;

const PLANET_FS = /* glsl */`
${G_NOISE}${G_MASK}
varying vec3 vW; varying vec3 vN; varying vec3 vO;
uniform mat4 modelMatrix;
uniform samplerCube uMapA,uMapB;
uniform sampler2D uRingTex;
uniform vec3 uAtm,uSunset,uEmCol,uCloudCol,uAurCol,uSunDir,uSunO,uSunCol,uAmb,uRingN;
uniform vec4 uP;     // cloud amount, specular, bump, differential rotation
uniform vec4 uP2;    // emission gain, storm lightning, aurora, detail frequency
uniform vec4 uP3;    // terminator softness, flow phase, jet frequency, jet seed
uniform vec4 uP4;    // micro detail amount, rim light, field-mask relax at the rim of the field, local contrast boost
uniform vec4 uRot;   // cloud angle, emission mode (0 city lights, 1 molten from map B, 2 molten crust from map A), haze, luminance knee under the field
uniform vec4 uRingP; // inner, outer (planet radii), shadow strength, profile row
uniform vec4 uImp;   // impact point (object space), age in s (<0: none)
uniform vec4 uMoonS[2]; // moon position (planet radii, world axes), radius
uniform float uOp,uTime,uGain,uEclipse;
vec3 rotY(vec3 p,float a){ float c=cos(a),s=sin(a); return vec3(c*p.x+s*p.z,p.y,c*p.z-s*p.x); }
// a line of constant pixel width along the n = .5 contour of a noise field (roads between cities)
float contour(float n,float wpx){ float w=max(fwidth(n),1e-5); return (1.-smoothstep(wpx-.6,wpx+.6,abs(n-.5)/w))*(1.-smoothstep(.2,.45,w)); }
void main(){
  vec3 o=normalize(vO); vec3 ng=normalize(vN); vec3 v=normalize(uCam-vW);
  vec4 A; vec4 B=texture(uMapB,o);
#ifndef LITE
  if(uP.w>0.){   // gas giants: every latitude drifts at its own speed (two phases, cross-faded)
    float jet=sin(o.y*uP3.z+uP3.w)+.5*sin(o.y*uP3.z*2.3+1.7+uP3.w);
    float ph=fract(uP3.y), ph2=fract(uP3.y+.5); float w1=1.-abs(2.*ph-1.);
    A=mix(texture(uMapA,rotY(o,jet*uP.w*(ph2-.5))),texture(uMapA,rotY(o,jet*uP.w*(ph-.5))),w1);
  } else
#endif
  A=texture(uMapA,o,-.4);
  vec3 alb=A.rgb*A.rgb;
  vec3 T=normalize(vec3(o.z,0.,-o.x)+vec3(1e-5,0.,0.)); vec3 Bt=cross(o,T);
  vec2 g=(B.rg-.5)*2.*uP.z;
  float ndlG=dot(ng,uSunDir);
  // what no cube map can hold: two octaves of grain and a micro relief, faded out before they alias
  float d1=n3(o*uP2.w);
#ifndef LITE
  float fwo=length(fwidth(o));
  float k1=1.-smoothstep(.1,.3,fwo*uP2.w), k2=1.-smoothstep(.1,.3,fwo*uP2.w*3.7);
  float es=.3/uP2.w;
  vec2 mg=vec2(n3((o+T*es)*uP2.w)-d1,n3((o+Bt*es)*uP2.w)-d1);
  float d2=n3(o*uP2.w*3.7+7.);
  vec3 am=textureLod(uMapA,o,5.).rgb; am*=am;                  // the blurred surface: for local contrast here, for the knee below
  alb=max(am+(alb-am)*(1.+uP4.w),0.);                           // unsharp mask: bands, coasts and craters keep their bite when the whole is dimmed
  alb*=1.+((d1-.5)*.24*k1+(d2-.5)*.2*k2)*uP4.x;
  g+=mg*(1.5*k1*uP4.x*uP.z);
  g*=1.+.9*(1.-smoothstep(0.,.45,abs(ndlG)));     // relief stands out along the terminator
#else
  alb*=1.+(d1-.5)*.2;
#endif
  vec3 n=normalize(mat3(modelMatrix)*(o-(g.x*T+g.y*Bt)));
  float cl=0.,csh=0.,clM=0.;
  if(uP.x>0.){
    vec3 oc=rotY(o,uRot.x);
    cl=clamp(texture(uMapB,oc).b*uP.x*(.8+.5*n3(oc*41.)),0.,1.);
#ifndef LITE
    csh=texture(uMapB,rotY(normalize(o+uSunO*(.014+.03*(1.-max(ndlG,0.)))),uRot.x)).b*uP.x;   // shadows lengthen toward the terminator
    clM=textureLod(uMapB,oc,4.).b*uP.x;
#endif
  }
  float ndl=dot(n,uSunDir);
  float ts=uP3.x;
  float day=smoothstep(-ts,ts*2.5+.02,ndlG);
  float wrap=day*(.3+.7*smoothstep(-.05,.75,ndlG));
  float relief=clamp(1.+(ndl-ndlG)/(max(ndlG,0.)+.2),.05,2.4);
  float vis=1.;
  if(uRingP.z>0.){   // the rings' shadow
    float dn=dot(uSunDir,uRingN);
    float tt=-dot(ng,uRingN)/(abs(dn)<1e-4?1e-4:dn);
    if(tt>0.){
      float u=(length(ng+uSunDir*tt)-uRingP.x)/(uRingP.y-uRingP.x);
      if(u>0.&&u<1.) vis*=1.-texture(uRingTex,vec2(u,uRingP.w)).a*uRingP.z;
    }
  }
  for(int i=0;i<2;i++){   // moon shadows (transits)
    vec4 m=uMoonS[i];
    if(m.w>0.){
      vec3 d=m.xyz-ng; float tt=dot(d,uSunDir);
      if(tt>0.) vis*=1.-.92*(1.-smoothstep(m.w*.65,m.w*1.25,length(d-uSunDir*tt)));
    }
  }
  vec3 sunC=uSunCol*mix(uSunset,vec3(1.),smoothstep(-.02,.4,ndlG));
  vec3 lit=alb*(1.-.68*clamp(csh-cl*.6,0.,1.))*(sunC*(wrap*relief*vis*uGain)+uAmb);
  vec3 hv=normalize(v+uSunDir); float nh=max(dot(normalize(mix(ng,n,.3)),hv),0.);
  lit+=uSunCol*(pow(nh,180.)*1.3+pow(nh,20.)*.12)*(A.a*uP.y*(1.-cl)*day*vis*uGain);
  // clouds shade themselves: the side of a bank that faces the sun is bright, its lee is grey
  float cshade=clamp(1.+(cl-csh)*1.1,.5,1.3);
  lit=mix(lit,uCloudCol*(sunC*(wrap*vis*uGain*cshade)+uAmb*1.5),cl);
  float fr=1.-max(dot(ng,v),0.); float fr2=fr*fr;
  vec3 aCol=mix(uSunset*dot(uAtm,vec3(.4)),uAtm,smoothstep(-.12,.45,ndlG));
  float aDay=smoothstep(-.3,.25,ndlG)*vis*uGain*1.6;
  lit=mix(lit,aCol*aDay,uRot.z*(.1+.9*fr2));
  lit+=aCol*(fr2*fr*.8+fr*.05)*aDay;
  // rim: the sunlit limb catches a little extra light, the dark limb a trace of the nebula behind it
  lit+=(alb*.5+.03)*(sunC*(day*vis*uGain*.45)+uAmb*5.)*(fr2*fr2*uP4.y);
  lit*=1.-.6*uEclipse;
  float fm=fieldMask(uCam,vW-uCam);
  float fmk=fm*(1.-uP4.z*fieldRim(uCam,vW-uCam));
  float night=1.-smoothstep(-.2,.06,ndlG);
  float eB=B.a*B.a;
  vec3 em=vec3(0.);
  if(uRot.y<.5){
    if(uP2.x>0.){   // city lights: dense cores, thin lit roads between them, a few lone lights
      float dn=sqrt(eB);
      // two crossing contour families make a mesh (one family alone only ever gives worms)
      float m1=max(contour(n3(o*43.+3.),.5),contour(n3(o*43.+19.7),.5));
      float m2=max(contour(n3(o*121.+11.),.5),contour(n3(o*121.+27.3),.5));
      float sp=n3(o*420.); float tw=n3(o*230.+17.);
      float core=smoothstep(.22,1.,pow(n3(o*52.+31.),4.)*6.*(.35+dn))*smoothstep(0.,.12,dn);   // the conurbations
      float lights=m1*(.22+.7*core)*smoothstep(0.,.22,dn)*(.45+1.1*sp)
                  +m2*core*1.2*(.4+1.3*sp)
                  +core*(.1+1.35*sp*sp*sp)
                  +pow(sp,9.)*dn*3.;
#ifndef LITE
      lights*=mix(1.,.55+.9*smoothstep(.2,.8,.5+.5*sin(uTime*(1.5+5.*tw)+tw*40.)),.45);   // twinkle
#endif
      float aaFar=smoothstep(.02,.06,fwidth(o.x)+fwidth(o.y)+fwidth(o.z));     // far away: only the glow of the conurbations is left
      lights=mix(lights,(core*.9+.15)*dn,aaFar);
      vec3 tint=mix(vec3(1.,.62,.3),vec3(.8,.92,1.15),smoothstep(.42,.62,n3(o*7.+9.)))*(1.+.8*core);
      em=uEmCol*tint*(lights*uP2.x*night*(1.-.9*cl)*(1.-.93*fm));
    }
  } else {
    float e=uRot.y>1.5?A.a*A.a:eB;
    // heat ramp: dull red → orange → yellow-white cores
    vec3 heat=uEmCol*(e*.42)+uEmCol.r*(vec3(1.,.5,.12)*(e*e*e*.8)+vec3(1.,.85,.6)*(pow(e,7.)*.6));
    float pulse=.85+.15*sin(uTime*.5+o.x*17.+o.y*11.);
    float dayK=uRot.y>1.5?.12:.22;
    em=heat*(uP2.x*pulse*mix(dayK,1.,night)*(1.-.75*cl)*(1.-.6*fm));
    if(uRot.y>1.5) em+=uEmCol*(cl*e*night*.25*(1.-fm));                                       // ash clouds lit from below
  }
  if(uP2.y>0.){   // lightning inside the storm cells: pin-sharp strokes that light up the clouds around them
    float storm=smoothstep(.3,.8,A.a);
    float cloudTex=(.2+1.7*dot(alb,vec3(.4)))*(.55+.9*B.b);
    for(int k=0;k<2;k++){
      vec3 pc=o*(7.+2.*float(k))+float(k)*3.7;   // two lattices of different pitch
      vec3 idk=floor(pc);
      vec4 hh=texture(uNoise,(idk+.5)*.03125);
      float tk=uTime*(.6+.5*hh.a)+hh.r*9.; float kk=floor(tk), f=fract(tk);
      vec4 h2=texture(uNoise,(idk+vec3(kk*7.,kk*13.,kk*5.)+.5)*.03125);
      if(h2.r<.14&&f<.5){
        float dd=length(pc-idk-.3-.4*h2.gba);                                // the whole flash stays inside its cell
        float env=exp(-f*22.)+.75*exp(-max(f-.13,0.)*26.)*step(.13,f)+.5*exp(-max(f-.3,0.)*30.)*step(.3,f);   // stroke, re-strokes
        float core=exp(-dd*dd*900.)*9.+exp(-dd*dd*160.)*1.2;
        float halo=exp(-dd*dd*20.)*cloudTex;
        em+=vec3(.62,.78,1.)*((core+halo*.9)*env*storm*uP2.y*(.3+.7*night)*max(dot(ng,v),0.)*(1.-.93*fm));
      }
    }
  }
  if(uP2.z>0.){   // auroral ovals
    float rp=n3(vec3(o.xz*2.5,uTime*.12+3.))-.5;
    float ov=exp(-sq((abs(o.y)-.86-.07*rp)/.03));
    float cur=.25+.75*n3(vec3(o.xz*16.,uTime*.45));
    em+=uAurCol*(ov*cur*cur*uP2.z*(.12+.88*night)*(1.-.8*fm));
  }
  if(uImp.w>=0.){ // comet strike: flash, shock ring racing over the surface, cooling scar
    float d=acos(clamp(dot(o,uImp.xyz),-1.,1.)); float t=uImp.w;
    float flash=exp(-d*d*(40.+t*30.))*exp(-t*1.4)*9.;
    float rr=.03+.36*(1.-exp(-t*.22));
    float ring=exp(-sq((d-rr)/(.008+.025*rr)))*exp(-t*.16)*smoothstep(0.,.4,t);
    float old=1.-smoothstep(80.,120.,t);                       // the scar heals instead of popping away
    lit*=1.-.75*exp(-d*d*500.)*smoothstep(0.,1.,t)*old;
    vec3 hot=mix(vec3(1.2,.25,.04),vec3(2.5,1.6,.7),exp(-t*.12));
    em+=(vec3(3.,2.4,1.6)*flash*(1.-.96*fm)+vec3(1.4,.7,.3)*ring+hot*(exp(-d*d*1400.)*(.2+2.*exp(-t*.07))*old))*(1.-.6*fm);
  }
  lit*=1.-uField.z*fmk;
#ifndef LITE
  // soft knee on the MACRO brightness (blurred albedo and cloud cover × sun): the planet as a whole
  // stays calm behind the bullets, while relief, cloud edges and surface detail keep their contrast
  float macro=dot(mix(am,uCloudCol,clamp(clM,0.,1.))*sunC,vec3(.25,.6,.15))*wrap*vis*uGain;
  lit/=1.+fmk*uRot.w*macro;
  float L=dot(lit,vec3(.25,.6,.15));
  lit/=1.+fm*4.*max(L-.3,0.);                                   // and no glint ever gets bullet-bright
#else
  lit/=1.+fmk*uRot.w*dot(lit,vec3(.25,.6,.15));
#endif
  gl_FragColor=vec4(lit+em,uOp);
  ${G_END}
}`;

const HALO_FS = /* glsl */`
${G_MASK}
varying vec3 vW; varying vec3 vN;
uniform vec3 uAtm,uSunset,uSunDir;
uniform float uOp,uLimb,uEclipse,uGain;
void main(){
  vec3 n=normalize(vN); vec3 v=normalize(uCam-vW);
  float k=max(-dot(n,v),0.);
  float t=clamp(k/uLimb,0.,1.);
  float inten=t*t*t*(.3+.7*t*t);
  vec3 limb=normalize(n+v*k);
  float sd=dot(limb,uSunDir);
  float day=smoothstep(-.4,.3,sd);
  float fwd=pow(max(dot(-v,uSunDir),0.),5.);          // back-lit: the air itself lights up
  vec3 c=mix(uSunset*dot(uAtm,vec3(.5)),uAtm,smoothstep(-.2,.35,sd));
  vec3 col=c*inten*(.03+.97*day)*(.8+2.2*fwd)*uGain*(1.-.5*uEclipse);
  col*=uOp*(1.-uField.z*fieldMask(uCam,vW-uCam));
  gl_FragColor=vec4(col,1.);
  ${G_END}
}`;

const RING_FS = /* glsl */`
${G_NOISE}${G_MASK}
varying vec3 vW; varying vec3 vN; varying vec3 vO;
uniform sampler2D uRingTex;
uniform vec3 uRingCol,uSunDir,uSunCol,uPC,uSeedP;
uniform vec4 uRingQ; // profile row, clumpiness, sparkle, -
uniform float uPR,uOp,uGain,uR0,uR1,uEclipse,uTime;
void main(){
  float dC=distance(vW,uCam);
  vec3 rd=(vW-uCam)/dC; vec3 co=uCam-uPC;
  float bb=dot(co,rd); float hh=bb*bb-(dot(co,co)-uPR*uPR);
  if(hh>0.){ float th=-bb-sqrt(hh); if(th>0.&&th<dC) discard; }
  float r=length(vO.xy); float t=(r-uR0)/(uR1-uR0);
  if(t<0.||t>1.) discard;
  vec4 pr=texture(uRingTex,vec2(t,uRingQ.x));
  float fw=fwidth(t);
  float fine=n3(vec3(t*230.+uSeedP.x,uSeedP.y,.5))*.6+n3(vec3(t*710.+uSeedP.z,uSeedP.x,2.5))*.4;
  float a=pr.a*mix(1.,.55+.9*fine,1.-smoothstep(.0015,.006,fw));
  if(uRingQ.y>0.){   // debris halo: clumps and arcs instead of clean bands
    float ang=atan(vO.y,vO.x);
    float c1=n3(vec3(cos(ang)*3.+uSeedP.x,sin(ang)*3.+uSeedP.y,t*5.))*.6+n3(vec3(vO.xy*17.,uSeedP.z))*.4;
    a*=mix(1.,smoothstep(.32,.7,c1)*1.5,uRingQ.y);
  }
  a=clamp(a,0.,1.)*smoothstep(0.,.012,t)*smoothstep(1.,.985,t);
  // the planet's shadow across the rings
  vec3 oc=vW-uPC; float b=dot(oc,uSunDir); float h=dot(oc,oc)-b*b;
  float sh=b<0.?smoothstep(uPR*uPR*.86,uPR*uPR*1.1,h):1.;
  vec3 N=normalize(vN);
  float sS=dot(N,uSunDir), sV=dot(N,-rd);
  float fwd=pow(max(dot(rd,uSunDir),0.),8.);
  float lum;
  if(sS*sV>0.) lum=(.3+.7*abs(sS))*(.75+.5*a)+fwd*.6;     // lit face
  else lum=(.12+2.4*a*(1.-a))*(.35+.65*abs(sS))+fwd*2.;   // seen from behind: thin bands glow, dense ones go dark
  float fm=fieldMask(uCam,vW-uCam);
  float spk=pow(n3(vec3(vO.xy*640.,uTime*.7)),44.)*uRingQ.z*(1.-smoothstep(.002,.01,fw))*(1.-fm);
  vec3 col=uRingCol*pr.rgb*uSunCol*((lum+spk*9.)*mix(.03,1.,sh)*uGain*(1.-.6*uEclipse));
  col*=1.-uField.z*fm;
  col/=1.+fm*3.*dot(col,vec3(.25,.6,.15));
  gl_FragColor=vec4(col,a*uOp*(sS*sV>0.?.92:.8));
  ${G_END}
}`;

/* ------------------------------- planet baker ------------------------------ */

const BAKE_VS = /* glsl */`
varying vec2 vUv;
void main(){ vUv=position.xy; gl_Position=vec4(position.xy,0.,1.); }`;

const BAKE_FS = /* glsl */`
varying vec2 vUv;
float sq(float x){ return x*x; }
uniform int uFace,uPass,uType;
uniform vec3 uSeedP,uC1,uC2,uC3,uC4;
uniform vec4 uPr,uPr2;
uniform float uEps;
vec3 h3(vec3 p){
  uvec3 v=uvec3(ivec3(floor(p))+ivec3(40000));
  v=v*1664525u+1013904223u; v.x+=v.y*v.z; v.y+=v.z*v.x; v.z+=v.x*v.y; v^=v>>16u; v.x+=v.y*v.z; v.y+=v.z*v.x; v.z+=v.x*v.y;
  return vec3(v)*(2./4294967296.)-1.;
}
float gn(vec3 p){
  vec3 i=floor(p),f=p-i; vec3 u=f*f*f*(f*(f*6.-15.)+10.);
  float a=dot(h3(i),f),b=dot(h3(i+vec3(1.,0.,0.)),f-vec3(1.,0.,0.)),c=dot(h3(i+vec3(0.,1.,0.)),f-vec3(0.,1.,0.)),d=dot(h3(i+vec3(1.,1.,0.)),f-vec3(1.,1.,0.));
  float e=dot(h3(i+vec3(0.,0.,1.)),f-vec3(0.,0.,1.)),g=dot(h3(i+vec3(1.,0.,1.)),f-vec3(1.,0.,1.)),h=dot(h3(i+vec3(0.,1.,1.)),f-vec3(0.,1.,1.)),k=dot(h3(i+vec3(1.,1.,1.)),f-vec3(1.,1.,1.));
  return mix(mix(mix(a,b,u.x),mix(c,d,u.x),u.y),mix(mix(e,g,u.x),mix(h,k,u.x),u.y),u.z)*1.5;
}
float fbm(vec3 p,int n){ float a=.5,s=0.; for(int i=0;i<8;i++){ if(i>=n) break; s+=a*gn(p); p=p*2.02+vec3(13.1,7.7,5.3); a*=.5; } return s; }
float rg(vec3 p){ return 1.-min(abs(gn(p)),1.); }
float ridge(vec3 p,int n){ float a=.5,s=0.,w=1.; for(int i=0;i<8;i++){ if(i>=n) break; float v=rg(p); v*=v; s+=a*v*w; w=clamp(v*1.6,0.,1.); p=p*2.07+vec3(3.3,7.1,5.9); a*=.5; } return s; }
vec3 wv(vec3 p){ return vec3(fbm(p+vec3(4.1,0.,0.),3),fbm(p+vec3(0.,7.3,0.),3),fbm(p+vec3(0.,0.,9.7),3)); }
vec3 rotAx(vec3 p,vec3 ax,float a){ float c=cos(a),s=sin(a); return p*c+cross(ax,p)*s+ax*dot(ax,p)*(1.-c); }
// impact craters: x = height (cell units), y = bright ejecta / rays
vec2 craters(vec3 p,float dens){
  vec3 i=floor(p); vec2 acc=vec2(0.); float lp=length(p);
  for(int z=-1;z<=1;z++)for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){
    vec3 id=i+vec3(float(x),float(y),float(z));
    vec3 k=h3(id+vec3(57.,113.,31.))*.5+.5;
    if(k.x>dens*1.5) continue;
    vec3 c=id+.5+.42*h3(id);
    // a centre is pulled onto the sphere; only cells that the sphere passes through may take part, and
    // nothing may reach further than the 3×3×3 search sees — else craters are cut along straight cell walls
    float lc=length(c); float wc=1.-smoothstep(.2,.36,abs(lc-lp));
    if(wc<=0.) continue;
    c*=lp/max(lc,.01);
    float r=.14+.36*k.y*k.y;
    vec3 dv=p-c; float d=length(dv)/r;
    wc*=1.-smoothstep(.5,.72,d*r);
    if(d<3.&&wc>0.){
      float fresh=k.z;
      float bowl=d<1.?(d*d-1.)*.5:0.;
      float rim=exp(-(d-1.)*(d-1.)*14.)*.22;
      float cp=exp(-d*d*30.)*.12*step(.3,r);
      acc.x+=(bowl+rim+cp)*r*(.45+.55*fresh)*wc;
      float ang=atan(dot(dv,vec3(.36,.48,.8)),dot(dv,vec3(.8,-.6,0.)));
      float ray=.5+.5*sin(ang*(7.+floor(k.y*9.))+k.x*40.);
      acc.y+=(fresh*fresh*fresh*exp(-max(d-1.,0.)*1.1)*step(1.,d)*(.3+.7*ray*ray)+fresh*fresh*rim*1.6)*wc;
    }
  }
  return acc;
}
// swirl the lookup position around nearby storm centres (ovals on gas giants, cyclones)
vec3 vortex(vec3 o,float freq,float dens,float rad,float twist,float flat_,inout float m){
  vec3 i=floor(o*freq); vec3 r=o;
  for(int z=-1;z<=1;z++)for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){
    vec3 id=i+vec3(float(x),float(y),float(z));
    vec3 k=h3(id+vec3(17.,31.,5.));
    if(k.x*.5+.5>dens) continue;
    vec3 c=id+.5+.4*h3(id); float lc=length(c); if(lc<.5) continue; c/=lc;
    vec3 dv=o-c;
    float d=length(vec3(dv.x,dv.y*flat_,dv.z))/(rad*(.55+.45*(k.y*.5+.5)));
    if(d<1.){ float w=(1.-d)*(1.-d); r=rotAx(r,c,twist*w*(k.z<0.?-1.:1.)); m=max(m,1.-d); }
  }
  return r;
}
// cracked crust: x = distance to the nearest plate boundary (cell units), y = plate id (-1…1)
vec2 plates(vec3 p){
  vec3 i=floor(p),f=p-i; float d1=9.,d2=9.; vec3 r1=vec3(0.),r2=vec3(0.); float id=0.;
  for(int z=-1;z<=1;z++)for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){
    vec3 g=vec3(float(x),float(y),float(z)); vec3 hh=h3(i+g);
    vec3 r=g+.5+.42*hh-f; float d=dot(r,r);
    if(d<d1){ d2=d1; r2=r1; d1=d; r1=r; id=hh.x; } else if(d<d2){ d2=d; r2=r; }
  }
  return vec2(dot(.5*(r1+r2),normalize(r2-r1)),id);
}
// shield volcanoes: x = cone height, y = caldera + radial lava streams (heat), z = ash plume downwind
vec3 volcano(vec3 p,float dens){
  vec3 i=floor(p); vec3 acc=vec3(0.); float lp=length(p);
  for(int z=-1;z<=1;z++)for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){
    vec3 id=i+vec3(float(x),float(y),float(z));
    vec3 k=h3(id+vec3(91.,7.,43.))*.5+.5;
    if(k.x>dens*1.5) continue;
    vec3 c=id+.5+.4*h3(id);
    float lc=length(c); float wc=1.-smoothstep(.2,.36,abs(lc-lp));   // see craters()
    if(wc<=0.) continue;
    c*=lp/max(lc,.01);
    float r=.15+.1*k.y;
    vec3 dv=p-c; float d=length(dv)/r;
    wc*=1.-smoothstep(.5,.72,d*r);
    if(d<3.2&&wc>0.){
      vec3 ax=normalize(c); vec3 t1=normalize(cross(ax,vec3(.31,.88,.2)+k.zxy*.4)); vec3 t2=cross(ax,t1);
      vec2 q=vec2(dot(dv,t1),dot(dv,t2))/r; vec2 qw=q+.22*vec2(gn(vec3(q*1.7,k.x*7.)),gn(vec3(q*1.7,k.y*7.+3.))); vec2 qd=qw/max(length(qw),1e-4);
      float cone=exp(-d*d*1.6)*(1.-.75*exp(-d*d*45.));
      float st=gn(vec3(qd*3.3,k.z*31.)+vec3(0.,0.,d*.45));
      float streams=sq(max(1.-abs(st)*11.,0.))*smoothstep(.1,.28,d)*exp(-d*1.1)*(1.-smoothstep(1.2,2.1,d));
      acc.x+=cone*r*.6*wc;
      acc.y=max(acc.y,(exp(-d*d*55.)+streams*.85)*wc);
      float along=q.x,across=q.y+.25*gn(vec3(q*.7,k.x*9.));
      float wd=.16+.3*max(along,0.);
      float pl=exp(-across*across/(wd*wd))*exp(-max(along,0.)*.8)*smoothstep(-.25,.15,along)*(1.-smoothstep(1.7,2.7,along))*(1.-smoothstep(2.4,3.1,d));
      acc.z=max(acc.z,pl*(.55+.45*k.z)*wc);
    }
  }
  return acc;
}
void sGas(vec3 o,int w,out float h,out vec3 col,out float mask,out float cloud,out float em){
  float m=0.;
  vec3 q=vortex(o,3.,uPr.z*.6,.24,3.2,1.8,m);
  vec3 gc=normalize(vec3(.6,uPr.y,.62)); vec3 dv=q-gc; float gd=length(vec3(dv.x,dv.y*2.1,dv.z))/.27; float gs=0.;
  if(gd<1.){ float ww=(1.-gd)*(1.-gd); q=rotAx(q,gc,8.*ww); gs=1.-gd; }
  float t1=fbm(q*vec3(1.6,5.,1.6)+uSeedP,5);
  float t2=fbm(q*vec3(2.5,8.,2.5)+uSeedP.zxy+t1*1.3,5);
  float y=q.y*uPr.x+(t1*.42+t2*.22)*uPr.w;
  float b1=gn(vec3(y,uSeedP.x,uSeedP.y)),b2=gn(vec3(y*2.3+5.,uSeedP.y,uSeedP.z)),b3=gn(vec3(y*6.1+9.,uSeedP.z,uSeedP.x));
  float st=fbm(vec3(q.x*1.6,y*4.,q.z*1.6)+uSeedP.yzx,5);
  float v=.5+.5*clamp(b1*1.5+b2*.6+b3*.25+st*.6,-1.,1.);
  h=.5+(v-.5)*.25+t2*.2+gs*.2+m*.12;
  mask=0.; cloud=0.; em=0.; col=vec3(0.);
  if(w==1) return;
  float storm=clamp(max(m*.8,gs)+smoothstep(.2,.5,abs(t2))*.5,0.,1.);
  if(w==0){
    col=mix(uC2,uC1,smoothstep(.22,.78,v));
    col=mix(col,uC3,smoothstep(.5,.95,.5+.5*clamp(b2*1.4+t2*1.6,-1.,1.))*.6);
    col=mix(col,uC4,smoothstep(.62,1.,.5+b3*.7+st*.9)*.4);
    col*=.82+.7*(t2+.4*st)+.1;
    col=mix(col,uC3*1.1,smoothstep(.15,.9,m)*.55);
    col*=1.-.3*smoothstep(0.,.1,m)*(1.-smoothstep(.1,.3,m));
    col=mix(col,uC4*1.2,smoothstep(0.,.55,gs)*.85);
    col*=1.-.4*smoothstep(0.,.1,gs)*(1.-smoothstep(.1,.28,gs));
    col=mix(col,uC2*.7,smoothstep(.7,.98,abs(o.y))*.6);
    mask=storm;
  } else {
    cloud=smoothstep(.12,.5,t2+.25*st)*.8;
    em=uPr2.z*clamp(smoothstep(.75,.2,v)*(.55+.9*(st+t2))+gs*.5,0.,1.);
  }
}
void sRock(vec3 o,int w,out float h,out vec3 col,out float mask,out float cloud,out float em){
  mask=0.; cloud=0.; em=0.; col=vec3(0.);
  float base=fbm(o*1.5+uSeedP,6);
  float mare=smoothstep(.02,-.14,fbm(o*1.05+uSeedP.zxy,4)+uPr.y);
  float rid=ridge(o*2.3+uSeedP.yzx,5);
  vec2 c1=craters(o*2.6+uSeedP,uPr.z),c2=craters(o*6.3+uSeedP.yzx,uPr.z),c3=craters(o*15.+uSeedP.zxy,uPr.z*.9);
  float cr=c1.x/2.6+c2.x/6.3+c3.x/15.;
  float can=smoothstep(.93,.99,rg(o*1.3+uSeedP.zyx+.6*base))*uPr.w;
  h=.5+(base*.45+rid*.22)*(1.-.8*mare)+cr*2.2-can*.12;
  if(w!=0) return;
  float tone=.5+.5*clamp(base*1.6+fbm(o*7.+uSeedP,4)*.6,-1.,1.);
  col=mix(uC2,uC1,tone); col=mix(col,uC3,mare*.85);
  col=mix(col,uC4,smoothstep(.45,.9,rid)*.4*(1.-mare));
  col*=1.+(c1.y+c2.y*.8+c3.y*.6)*.55;
  col*=clamp(1.+cr*7.,.5,1.35);
  col*=1.-.6*can;
  col*=.8+.4*(.5+fbm(o*40.+uSeedP,3));
}
void sOcean(vec3 o,int w,out float h,out vec3 col,out float mask,out float cloud,out float em){
  mask=0.; cloud=0.; em=0.; col=vec3(0.);
  vec3 q=o*uPr.x+uSeedP; q+=.32*wv(q*1.4);
  float e=fbm(q,7)+uPr.y;
  float land=smoothstep(0.,.012,e);
  float mt=ridge(o*3.7+uSeedP.yzx,5)*smoothstep(.02,.22,e)*smoothstep(-.1,.25,fbm(o*1.9+uSeedP.zxy,3)+.1);
  float elev=max(e,0.)*.9+mt*.5;
  float lat=abs(o.y)+.07*fbm(o*5.+uSeedP,3);
  float ice=smoothstep(uPr.w-.02,uPr.w+.04,lat+elev*.25);
  h=.5+elev*land+ice*.03*(.5+fbm(o*20.,3));
  if(w==1) return;
  if(w==0){
    float dp=clamp(-e*5.,0.,1.);
    vec3 sea=mix(uC1*1.7+vec3(0.,.05,.04),uC1*.5,sqrt(dp));
    float moist=fbm(o*2.2+uSeedP.zxy,4);
    float dry=smoothstep(-.12,.14,.22*(1.-smoothstep(.08,.4,abs(lat-.3)))-moist-.02);
    vec3 lc=mix(uC2,uC3,dry);
    lc=mix(lc,uC2*.5,smoothstep(0.,.3,moist)*(1.-dry));
    lc=mix(lc,vec3(.32,.29,.25),smoothstep(.5,.72,lat));
    lc=mix(lc,vec3(.3,.27,.25)*(.8+mt),smoothstep(.18,.4,elev));
    lc=mix(lc,vec3(.9,.92,.95),smoothstep(.42,.6,elev+lat*.25));
    lc*=.78+.44*(.5+fbm(o*26.+uSeedP,3));
    lc=mix(lc,uC3*1.15,(1.-smoothstep(0.,.02,e))*.5);
    col=mix(sea,lc,land);
    col=mix(col,vec3(.86,.9,.95)*(.85+.3*fbm(o*30.,3)),ice);
    mask=(1.-land)*(1.-ice);
  } else {
    float m=0.; vec3 qc=vortex(o,2.2,.3,.34,2.8,1.,m);
    vec3 cq=qc*vec3(2.1,2.9,2.1)+uSeedP.yzx*1.3; cq+=.45*wv(cq*1.2);
    float cf=fbm(cq,6)+.35*fbm(cq*4.+3.,4);
    float ay=abs(o.y);
    float belt=.1*exp(-o.y*o.y*40.)+.08*smoothstep(.35,.6,ay)-.1*smoothstep(.15,.3,ay)*(1.-smoothstep(.3,.45,ay));
    cloud=smoothstep(.05,.5,cf+belt+uPr.z+m*.22)*(1.-.9*smoothstep(.85,1.,m));
    // population density only — the lights themselves (cores, roads, twinkle) are drawn per pixel at run time
    float civ=smoothstep(-.06,.2,fbm(o*2.7+uSeedP.zxy*2.,3))*land*(1.-ice)*(1.-smoothstep(.12,.3,elev))*(1.-smoothstep(.55,.7,lat));
    float coast=.22+.78*exp(-max(e,0.)*26.);
    float metro=smoothstep(.02,.4,fbm(o*11.+uSeedP,4))+.5*smoothstep(.15,.4,fbm(o*27.+uSeedP.yzx,3));
    em=clamp(civ*coast*metro*uPr2.y*1.25,0.,1.);
  }
}
void sDesert(vec3 o,int w,out float h,out vec3 col,out float mask,out float cloud,out float em){
  mask=0.; cloud=0.; em=0.; col=vec3(0.);
  vec3 q=o*uPr.x+uSeedP; q+=.3*wv(q*1.3);
  float e=fbm(q,7);
  float rid=ridge(o*3.1+uSeedP.yzx,5);
  float can=smoothstep(.9,.985,rg(o*1.15+uSeedP.zyx+.5*fbm(o*2.3+uSeedP,3)))*smoothstep(-.1,.2,gn(o*.9+uSeedP.yxz)+.15)*uPr.y;
  vec2 c1=craters(o*4.+uSeedP,uPr.z),c2=craters(o*11.+uSeedP.yzx,uPr.z);
  float cr=c1.x/4.+c2.x/11.;
  float lat=abs(o.y)+.06*fbm(o*6.+uSeedP,3);
  float cap=smoothstep(uPr.w-.015,uPr.w+.03,lat);
  h=.5+e*.5+rid*.2*smoothstep(-.1,.3,e)+cr*2.-can*.16+cap*.04;
  if(w==1) return;
  if(w==0){
    col=mix(uC2,uC1,.5+.5*clamp(e*1.8,-1.,1.));
    float dark=smoothstep(.05,.3,fbm(o*1.7+uSeedP.zxy,5)+.02);
    col=mix(col,uC3,dark*.75);
    col=mix(col,uC4,smoothstep(.45,.85,rid)*smoothstep(-.1,.3,e)*.5);
    col*=1.+gn(vec3(o.x*70.,o.y*210.,o.z*70.)+uSeedP)*(1.-dark)*.12;
    col*=clamp(1.+cr*8.,.6,1.3)*(1.+(c1.y+c2.y)*.25);
    col*=1.-.65*can;
    col*=.82+.36*(.5+fbm(o*34.+uSeedP,3));
    col=mix(col,vec3(.9,.9,.92),cap);
    mask=cap*.3;
  } else {
    vec3 cq=o*vec3(2.,3.4,2.)+uSeedP.yzx; cq+=.5*wv(cq*1.1);
    cloud=smoothstep(.12,.5,fbm(cq,5)+uPr2.w)*.8;
    float civ=smoothstep(.1,.3,fbm(o*3.3+uSeedP.zxy*2.,3))*(1.-cap)*(1.-smoothstep(.3,.5,rid));
    float oasis=exp(-can*4.)*.4+smoothstep(.75,.95,rg(o*1.15+uSeedP.zyx+.5*fbm(o*2.3+uSeedP,3)))*.9;   // settlements follow the canyons
    em=clamp(civ*(smoothstep(.1,.42,fbm(o*13.+uSeedP,3))*.6+.4*smoothstep(.2,.4,fbm(o*29.+uSeedP,3)))*oasis*uPr2.y*.95,0.,1.);
  }
}
void sIce(vec3 o,int w,out float h,out vec3 col,out float mask,out float cloud,out float em){
  mask=0.; cloud=0.; em=0.; col=vec3(0.);
  float e=fbm(o*1.4+uSeedP,5);
  vec3 wq=o+.13*wv(o*1.3+uSeedP);
  float l1=rg(wq*uPr.x+uSeedP.yzx),l2=rg(wq*uPr.x*2.3+uSeedP.zxy),l3=rg(wq*uPr.x*5.1+uSeedP);
  float L=max(pow(l1,22.),max(pow(l2,26.)*.8,pow(l3,30.)*.55));
  float chaos=smoothstep(.1,.3,fbm(o*2.1+uSeedP.zxy,4));
  vec2 c1=craters(o*5.+uSeedP,uPr.z);
  float rough=fbm(o*18.+uSeedP,4);
  h=.5+e*.15+L*.05-pow(l1,60.)*.07+c1.x/5.*1.6+chaos*rough*.12;
  if(w!=0) return;
  col=mix(uC2,uC1,.5+.5*clamp(e*2.,-1.,1.));
  col=mix(col,uC4,chaos*(.35+.5*(.5+rough)));
  col=mix(col,uC3,clamp(L*1.1,0.,1.)*.85);
  col*=clamp(1.+c1.x*5.,.7,1.25); col=mix(col,vec3(.95),clamp(c1.y*.5,0.,1.));
  col*=.88+.24*(.5+fbm(o*40.+uSeedP,3));
  col=mix(col,vec3(.93,.95,.98),smoothstep(.75,.95,abs(o.y)+e*.3)*.7);
  mask=(1.-L)*(1.-chaos*.6);
}
// A crusted lava world: black basalt plates, a branching network of glowing rifts that is dense
// in the active provinces and peters out in the dead ones, a few lava seas (cracked, rafted
// crust — not a uniform glow), shield volcanoes with radial streams and ash plumes.
// Heat goes into map A's alpha (the hi-res map): the veins have to stay crisp.
void sLava(vec3 o,int w,out float h,out vec3 col,out float mask,out float cloud,out float em){
  mask=0.; cloud=0.; em=0.; col=vec3(0.);
  vec3 wq=o+.17*wv(o*1.6+uSeedP)+.03*wv(o*6.5+uSeedP.yzx);
  float act=fbm(o*1.1+uSeedP.zxy,4)+uPr.y;                 // tectonic activity
  float a01=smoothstep(-.3,.3,act);
  float sea=smoothstep(.2,.24,act+.04*fbm(o*9.+uSeedP,3));
  vec2 P1=plates(wq*uPr.x*1.55+uSeedP.yzx), P2=plates(wq*uPr.x*4.1+uSeedP.zxy);
  vec3 vo=volcano(o*1.7+uSeedP.zyx,uPr.z);
  float w1=.007+.026*a01*a01, w2=.009+.02*a01;
  float k1=1.-smoothstep(0.,w1,P1.x);
  float gate2=smoothstep(.3,.62,a01+.22*P1.y);            // secondary cracks only where the crust is thin
  float k2=(1.-smoothstep(0.,w2,P2.x))*gate2;
  float rv=smoothstep(.972,.993,rg(wq*uPr.x*2.1+uSeedP))*smoothstep(-.05,.25,gn(o*1.9+uSeedP.yxz))*(.4+.6*a01);   // tributaries
  float crack=max(max(k1*k1,k2*k2*.8),rv*.7)*(1.-sea);
  float pl=fbm(o*5.+uSeedP,5);
  h=.5+(.16+pl*.22+P1.y*.018+P2.y*.01)*(1.-sea)-crack*.07+vo.x*.9-sea*.02;
  if(w==1) return;
  // lava seas: rafts of dark crust with bright seams, hottest along the shore
  float shore=sea*(1.-smoothstep(.24,.3,act));
  vec2 P3=plates(wq*uPr.x*10.+uSeedP);
  float seam=1.-smoothstep(0.,.04+.07*shore,P3.x);
  float heat=crack*(.55+.45*a01)+sea*(.05+.62*seam*seam*(.4+.6*P3.y*P3.y)+.45*shore*seam)+vo.y*(1.-sea);
  if(w==0){
    float tone=.5+.5*clamp(pl*2.+P2.y*.15,-1.,1.);
    col=mix(uC2,uC1,tone)*(.95+.08*P1.y);                    // every plate has its own shade of basalt
    col=mix(col,uC4,smoothstep(.1,.45,fbm(o*3.+uSeedP.yzx,4))*.45*(1.-a01));     // old ash plains in the dead provinces
    col=mix(col,uC4*1.15,clamp(vo.z*.5,0.,.6));              // fresh ash downwind of the volcanoes
    col*=.72+.56*(.5+fbm(o*30.+uSeedP,3));
    col*=1.-.55*smoothstep(0.,.5,max(k1,k2));                // scorched along the rifts
    col=mix(col,uC2*.6,sea*.85);
    col=mix(col,uC3,clamp(heat*1.4,0.,1.)*.8);               // the melt itself is dull red in daylight
    mask=clamp(heat,0.,1.);
  } else {
    cloud=clamp(vo.z*1.2*(.55+.9*(.5+fbm(o*14.+uSeedP,3)))+smoothstep(.22,.5,fbm(o*vec3(1.8,2.6,1.8)+uSeedP.yzx,5))*.16*a01,0.,1.);
  }
}
void sShatter(vec3 o,int w,out float h,out vec3 col,out float mask,out float cloud,out float em){
  mask=0.; cloud=0.; em=0.; col=vec3(0.);
  float base=fbm(o*1.6+uSeedP,6);
  vec3 wq=o+.3*wv(o*1.3+uSeedP);
  float g1=rg(wq*.85+uSeedP.yzx),g2=rg(wq*2.1+uSeedP.zxy),g3=rg(wq*5.+uSeedP);
  float chasm=smoothstep(.93,.985,g1);
  float crack=max(pow(g2,18.)*.8,pow(g3,24.)*.5)*smoothstep(.5,.9,g1);
  vec2 c1=craters(o*3.4+uSeedP,uPr.z),c2=craters(o*8.+uSeedP.yzx,uPr.z);
  float cr=c1.x/3.4+c2.x/8.;
  h=.5+base*.45+cr*2.-chasm*.3-crack*.06;
  if(w!=0) return;
  col=mix(uC2,uC1,.5+.5*clamp(base*1.8+fbm(o*8.+uSeedP,4)*.5,-1.,1.));
  col*=clamp(1.+cr*7.,.55,1.3)*(.8+.4*(.5+fbm(o*36.+uSeedP,3)));
  col=mix(col,uC3*.35,chasm); col*=1.-.5*crack;
  float core=smoothstep(.975,.998,g1);
  mask=clamp(core*(.6+.6*(.5+fbm(wq*9.+uSeedP,4)))+chasm*.12+crack*.5,0.,1.);   // heat, in the hi-res map
}
void surf(vec3 o,int w,out float h,out vec3 col,out float mask,out float cloud,out float em){
  if(uType==0) sGas(o,w,h,col,mask,cloud,em);
  else if(uType==1) sRock(o,w,h,col,mask,cloud,em);
  else if(uType==2) sIce(o,w,h,col,mask,cloud,em);
  else if(uType==3) sLava(o,w,h,col,mask,cloud,em);
  else if(uType==4) sOcean(o,w,h,col,mask,cloud,em);
  else if(uType==5) sDesert(o,w,h,col,mask,cloud,em);
  else sShatter(o,w,h,col,mask,cloud,em);
}
void main(){
  vec2 s=vUv; vec3 d;
  if(uFace==0) d=vec3(1.,-s.y,-s.x); else if(uFace==1) d=vec3(-1.,-s.y,s.x);
  else if(uFace==2) d=vec3(s.x,1.,s.y); else if(uFace==3) d=vec3(s.x,-1.,-s.y);
  else if(uFace==4) d=vec3(s.x,-s.y,1.); else d=vec3(-s.x,-s.y,-1.);
  vec3 o=normalize(d);
  float h,mask,cloud,em; vec3 col;
  if(uPass==0){
    surf(o,0,h,col,mask,cloud,em);
    gl_FragColor=vec4(sqrt(clamp(col,0.,1.)),(uType==3||uType==6)?sqrt(mask):mask);
  } else {
    surf(o,2,h,col,mask,cloud,em);
    vec3 T=normalize(vec3(o.z,0.,-o.x)+vec3(1e-5,0.,0.)); vec3 Bt=cross(o,T);
    float h1,h2,m_,c_,e_; vec3 k_;
    surf(normalize(o+T*uEps),1,h1,k_,m_,c_,e_);
    surf(normalize(o+Bt*uEps),1,h2,k_,m_,c_,e_);
    vec2 g=vec2(h1-h,h2-h)/uEps*uPr2.x;
    gl_FragColor=vec4(clamp(g*.5+.5,0.,1.),cloud,sqrt(clamp(em,0.,1.)));
  }
}`;

/* ----------------------------- bolts / comets ------------------------------ */

const BOLT_VS = /* glsl */`
attribute vec3 aA; attribute vec3 aB; attribute vec3 aUV; // end, side, width
uniform float uPx,uAspect;
varying float vS; varying float vB;
void main(){
  mat4 pv=projectionMatrix*viewMatrix;
  vec4 cA=pv*vec4(aA,1.); vec4 cB=pv*vec4(aB,1.);
  if(cA.w<5.||cB.w<5.){ gl_Position=vec4(2.,2.,2.,1.); return; }
  vec2 asp=vec2(uAspect,1.);
  vec2 A=cA.xy/cA.w*asp,B=cB.xy/cB.w*asp;
  vec2 ax=B-A; float len=length(ax);
  vec2 dir=len>1e-6?ax/len:vec2(1.,0.);
  vec4 c=aUV.x>.5?cB:cA;
  float wd=max(aUV.z*projectionMatrix[1][1]/c.w,2.2*uPx);
  vec2 p=(aUV.x>.5?B:A)+vec2(-dir.y,dir.x)*aUV.y*wd+dir*(aUV.x-.5)*wd*.6;
  gl_Position=vec4(p/asp,.5,1.);
  vS=aUV.y; vB=min(aUV.z/9.,1.);
}`;

const BOLT_FS = /* glsl */`
uniform float uLife; uniform vec3 uBoltCol;
varying float vS; varying float vB;
void main(){
  float c=exp(-vS*vS*22.)+exp(-vS*vS*3.2)*.14;
  c*=1.-smoothstep(.75,1.,abs(vS));
  gl_FragColor=vec4(uBoltCol*c*uLife*(.35+.65*vB),1.);
  ${G_END}
}`;

const COMET_VS = /* glsl */`
uniform vec3 uA,uB; uniform float uPx,uAspect,uW;
varying vec2 vUv;
void main(){
  mat4 pv=projectionMatrix*viewMatrix;
  vec4 cA=pv*vec4(uA,1.); vec4 cB=pv*vec4(uB,1.);
  if(cA.w<5.||cB.w<5.){ gl_Position=vec4(2.,2.,2.,1.); return; }
  vec2 asp=vec2(uAspect,1.);
  vec2 A=cA.xy/cA.w*asp,B=cB.xy/cB.w*asp;
  vec2 ax=B-A; float len=length(ax);
  vec2 dir=len>1e-6?ax/len:vec2(1.,0.);
  float e=position.x*.5+.5;
  float wd=max(uW*projectionMatrix[1][1]/cA.w,3.*uPx);
  vec2 p=mix(A,B,e)+vec2(-dir.y,dir.x)*position.y*wd*(1.+e*1.5)-dir*(1.-e)*wd;
  gl_Position=vec4(p/asp,.5,1.);
  vUv=vec2(e,position.y);
}`;

const COMET_FS = /* glsl */`
${G_MASK}
uniform vec3 uCometCol; uniform float uLife,uHead;
varying vec2 vUv;
void main(){
  float u=vUv.x,v=vUv.y;
  float tail=exp(-u*4.2)*exp(-v*v*(5.+u*3.))*(1.-smoothstep(.8,1.,abs(v)));
  float head=exp(-(u*u*900.+v*v*26.));
  vec3 col=uCometCol*(tail*.35+head*2.2*uHead)+vec3(1.)*head*1.2*uHead;
  gl_FragColor=vec4(col*uLife,1.);
  ${G_END}
}`;

/* ------------------------- event sprites + far ships ------------------------ */

// "blips": every small light an ambient event needs (running lights, laser
// pinpricks, explosions, meteors, beacons, wormhole rims) — one instanced draw.
const BLIP_VS = /* glsl */`
${G_MASK}
attribute vec4 aP;  // position (world, or camera-relative when w = 1: the far sky)
attribute vec4 aQ;  // tail offset, shape
attribute vec4 aK;  // colour, world half-size
uniform float uPx,uAspect;
varying vec2 vUv; varying vec3 vCol; varying float vLen; varying float vShape;
void main(){
  vec3 wp=aP.w>.5?uCam+aP.xyz:aP.xyz;
  mat4 pv=projectionMatrix*viewMatrix;
  vec4 c0=pv*vec4(wp,1.); vec4 c1=pv*vec4(wp+aQ.xyz,1.);
  if(c0.w<5.||c1.w<5.||aK.w<=0.){ gl_Position=vec4(2.,2.,2.,1.); return; }
  vec2 asp=vec2(uAspect,1.);
  vec2 A=c0.xy/c0.w*asp,B=c1.xy/c1.w*asp;
  vec2 ax=B-A; float len=length(ax);
  vec2 dir=len>1e-6?ax/len:vec2(1.,0.);
  float wpx=aK.w*projectionMatrix[1][1]/c0.w/uPx;
  float sz=max(wpx,1.4)*uPx;
  vec2 p=mix(A,B,position.x*.5+.5)+dir*position.x*sz+vec2(-dir.y,dir.x)*position.y*sz;
  gl_Position=vec4(p/asp,.5,1.);
  vUv=position.xy; vLen=len/sz; vShape=aQ.w;
  // never a bright dot or streak behind the bullets
  vCol=aK.rgb*(1.-.97*fieldMask(uCam,wp-uCam))*max(min(1.,wpx/1.4),.3);
}`;

const BLIP_FS = /* glsl */`
varying vec2 vUv; varying vec3 vCol; varying float vLen; varying float vShape;
float sq(float x){ return x*x; }
void main(){
  float b; vec2 a=abs(vUv); float r2=dot(vUv,vUv);
  if(vShape<.5) b=exp(-r2*5.)*(1.-smoothstep(.7,1.,r2));
  else if(vShape<1.5){   // streak: bright head at A, fading tail
    float ax=max(a.x*(1.+vLen)-vLen,0.); float q2=ax*ax+vUv.y*vUv.y;
    b=exp(-q2*5.)*(1.-smoothstep(.7,1.,q2))*mix(1.,pow(clamp(1.-(vUv.x*.5+.5),0.,1.),1.5),clamp(vLen*.5,0.,1.));
  }
  else if(vShape<2.5){ float r=sqrt(r2); b=(exp(-sq((r-.72)/.06))+exp(-sq((r-.72)/.2))*.22)*(1.-smoothstep(.9,1.,r)); }
  else if(vShape<3.5){ b=exp(-r2*90.)+(exp(-a.y*40.)*exp(-a.x*4.)+exp(-a.x*40.)*exp(-a.y*4.))*.4+exp(-r2*14.)*.08; b*=1.-smoothstep(.72,1.,max(r2,max(a.x,a.y))); }
  else b=(exp(-r2*3.)*.5+exp(-r2*18.))*(1.-smoothstep(.6,1.,r2));
  gl_FragColor=vec4(vCol*b,1.);
  ${G_END}
}`;

// far ships / stations / tumbling rocks: merged kits, one instanced draw each; a vertex only
// survives in the instance that asked for its model. Per vertex: albedo (or emission colour) and
// a surface kind — 0 plated hull, 1 window band, 2 engine glow, 3 light strip, 4 solar panel,
// 5 rock, 6 bare structure.
// Sorting: instances are sorted back to front on the CPU every frame. Inside a model the
// triangles are resolved by the depth buffer — but in a sliver at the very far end of the
// depth range (≙ beyond ~16 000 units), remapped to the span the instances really occupy:
// the kit can never occlude gameplay, it only stops drawing its own far side over its near
// side. (opts.shipDepth = false → no depth at all, parts are then painted bottom-up.)
const SHIP_VS = /* glsl */`
attribute vec2 aMdl;            // model, surface kind
attribute vec3 aCol;
attribute vec4 aIP,aIQ,aIS,aIX; // pos + model | quaternion | scale + opacity | seed, glow, team tint, hidden-by-planet flag
uniform vec2 uDR;               // view-depth span of the instances (near, far)
varying vec3 vW; varying vec3 vN; varying vec3 vO; varying vec3 vNo; varying vec4 vX; varying vec4 vC; varying float vOp;
vec3 qr(vec4 q,vec3 v){ return v+2.*cross(q.xyz,cross(q.xyz,v)+q.w*v); }
void main(){
  if(abs(aMdl.x-aIP.w)>.5||aIS.w<=0.){ gl_Position=vec4(2.,2.,2.,1.); return; }
  vO=position; vNo=normal;
  vec3 p=aIP.xyz+qr(aIQ,position*aIS.xyz);
  vN=qr(aIQ,normal/aIS.xyz); vW=p; vX=aIX; vC=vec4(aCol,aMdl.y); vOp=aIS.w;
  vec4 cp=projectionMatrix*viewMatrix*vec4(p,1.);
#ifdef SHIP_DEPTH
  float zp=clamp(uDR.y/(uDR.y-uDR.x)*(1.-uDR.x/max(cp.w,1e-3)),0.,1.);
  cp.z=cp.w*mix(.9997,.99999,zp);
#endif
  gl_Position=cp;
}`;

const SHIP_FS = /* glsl */`
${G_NOISE}${G_MASK}
varying vec3 vW; varying vec3 vN; varying vec3 vO; varying vec3 vNo; varying vec4 vX; varying vec4 vC; varying float vOp;
uniform vec3 uKey,uSunCol,uAmb2;
uniform vec4 uOcc;   // a planet that can hide flagged instances (centre, radius)
uniform float uEclipse,uTime;
float hash2(vec2 p){ return texture(uNoise,vec3(p+.5,7.5)*.03125).r; }
void main(){
  vec3 rd=vW-uCam; float dC=length(rd); rd/=dC;
  if(vX.w>.5&&uOcc.w>0.){   // behind the limb of its planet
    vec3 co=uCam-uOcc.xyz; float bb=dot(co,rd); float hh=bb*bb-(dot(co,co)-uOcc.w*uOcc.w);
    if(hh>0.){ float th=-bb-sqrt(hh); if(th>0.&&th<dC) discard; }
  }
  vec3 n=normalize(vN);
  float fm=fieldMask(uCam,rd);
  float kind=vC.a;
  vec3 an=abs(normalize(vNo));
  vec2 uv=an.y>.62?vO.xz:(an.z>.62?vO.xy:vO.zy);
  vec3 key=normalize(normalize(uKey-vW)+vec3(0.,.45,0.));   // the sun is a place: hulls beyond it show their lit side
  float ndl=max(dot(n,key),0.);
  float sky=.5+.5*n.y;
  vec3 light=uSunCol*(ndl*1.15)+uAmb2*(.45+1.1*sky);
  vec3 col; vec3 em=vec3(0.); float a=vOp;
  if(kind>4.5&&kind<5.5){            // rock
    col=vec3(.2,.185,.17)*(.5+.95*n3(vO*3.+vX.x*7.))*(.75+.5*n3(vO*11.+vX.x));
    col*=light;
  } else {
    vec3 alb=vC.rgb;
    if(vX.z>.5&&kind<.5) alb=alb.grb*vec3(1.25,.72,.62)+vec3(.02,0.,0.);   // the other fleet: bronze / oxblood hulls
    float fw=fwidth(uv.x)+fwidth(uv.y);
    if(kind<.5){                     // plating: big panels, sub-panels, seams
      vec2 g1=uv*26.+vX.x*3., g2=uv*104.+vX.x*5.;
      float t1=hash2(floor(g1)), t2=hash2(floor(g2)+17.);
      vec2 f1=abs(fract(g1)-.5), f2=abs(fract(g2)-.5);
      float a1=1.-smoothstep(.04,.14,fw*26.), a2=1.-smoothstep(.04,.14,fw*104.);
      float seam=(1.-smoothstep(.5-fw*26.*1.2,.5,max(f1.x,f1.y)))*a1;
      alb*=1.+((t1-.5)*.34*a1+(t2-.5)*.2*a2);
      alb*=1.-.45*(1.-seam)*a1;
      alb*=.9+.2*n3(vO*9.+vX.x);
    } else if(kind<1.5){             // window band: dark glazing, rows of lit windows
      vec2 gw=uv*vec2(240.,150.); vec2 fq=fract(gw);
      float lit=step(.42,hash2(floor(gw)+vX.x*31.))*step(.2,fq.x)*step(fq.x,.8)*step(.22,fq.y)*step(fq.y,.78);
      float aw=1.-smoothstep(.15,.5,fw*240.);
      vec3 wc=mix(vec3(1.,.8,.5),vec3(.7,.86,1.),step(.8,hash2(floor(gw*.25)+3.)));
      em=wc*(mix(.4,lit,aw)*.55*vX.y*(1.-.8*fm));
      alb=vec3(.035,.04,.05);
    } else if(kind<2.5){             // engines: vC = emission colour
      float fl=.8+.2*sin(uTime*23.+vX.x*40.+vO.z*90.);
      em=vC.rgb*(fl*vX.y*(1.-.72*fm)); alb=vec3(0.); a*=clamp(dot(vC.rgb,vec3(.5)),0.,1.);
    } else if(kind<3.5){             // light strips / beacons
      em=vC.rgb*(vX.y*(1.-.85*fm)); alb=vec3(.03);
    } else if(kind<4.5){             // solar panels: dark blue cells, bright busbars, a sheen
      vec2 gp=uv*vec2(46.,46.); vec2 fp=abs(fract(gp)-.5);
      float line=smoothstep(.42,.48,max(fp.x,fp.y))*(1.-smoothstep(.1,.3,fw*46.));
      alb=mix(vec3(.02,.035,.09),vec3(.2,.22,.26),line);
      vec3 hv=normalize(key-rd); em=uSunCol*pow(max(dot(n,hv),0.),40.)*.5*(1.-fm);
    } else alb*=.8+.4*n3(vO*30.+vX.x);
    vec3 hv=normalize(key-rd);
    col=alb*light+uSunCol*(pow(max(dot(n,hv),0.),24.)*.1*step(kind,.5));
    col+=alb*uAmb2*(pow(clamp(1.-dot(n,-rd),0.,1.),3.)*2.2);     // rim: the silhouette separates from the sky
  }
  col*=(1.-.6*uEclipse)*(1.-.62*fm);
  gl_FragColor=vec4(col+em,a);
  ${G_END}
}`;

/* -------------------------------- palettes -------------------------------- */

// star classes: [name, colour (linear-ish, max 1), angular radius (rad), disc intensity, key-light gain]
const STAR_CLASS = {
  yellow: { col: [1.0, 0.86, 0.6], r: 0.03, i: 1.0, key: [1.0, 0.93, 0.8] },
  white: { col: [0.95, 0.95, 1.0], r: 0.026, i: 1.05, key: [1.0, 0.98, 0.96] },
  blue: { col: [0.55, 0.74, 1.0], r: 0.038, i: 1.2, key: [0.8, 0.9, 1.0] },
  red: { col: [1.0, 0.36, 0.16], r: 0.05, i: 0.7, key: [1.0, 0.72, 0.56] },
  orange: { col: [1.0, 0.6, 0.26], r: 0.058, i: 0.85, key: [1.0, 0.84, 0.66] },
};
// planet types: bake program, runtime look (clouds, specular, bump, differential rotation, emission
// gain + mode, storm lightning, aurora, terminator softness, atmosphere shell, haze), ring chance
const PT = {
  gas:     { b: 0, cloud: 0.3, spec: 0, bump: 0.6, flow: 0.5, em: 0, mode: 0, ltn: 1, aur: 1, term: 0.16, halo: 1.1, haze: 0.26, bk: 0.05, det: 60, da: 0.45, rim: 0.4, gain: 1, ring: 0.65 },
  hotjup:  { b: 0, cloud: 0.25, spec: 0, bump: 0.6, flow: 0.6, em: 1.2, mode: 1, ltn: 1, aur: 0, term: 0.16, halo: 1.13, haze: 0.3, bk: 0.05, det: 60, da: 0.45, rim: 0.4, gain: 1, ring: 0.9 },
  rock:    { b: 1, cloud: 0, spec: 0, bump: 1, flow: 0, em: 0, mode: 0, ltn: 0, aur: 0, term: 0.015, halo: 0, haze: 0, bk: 0.14, det: 110, da: 1, rim: 1, gain: 1.15, ring: 0.1 },
  ice:     { b: 2, cloud: 0, spec: 0.45, bump: 1, flow: 0, em: 0, mode: 0, ltn: 0, aur: 0.8, term: 0.04, halo: 1.05, haze: 0.05, bk: 0.2, det: 110, da: 0.8, rim: 0.8, gain: 0.8, ring: 0.3 },
  lava:    { b: 3, cloud: 0.9, spec: 0, bump: 1, flow: 0, em: 1, mode: 2, ltn: 0, aur: 0, term: 0.05, halo: 1.05, haze: 0.07, bk: 0.2, det: 110, da: 1, rim: 0.8, gain: 1.25, ring: 0 },
  ocean:   { b: 4, cloud: 1, spec: 1, bump: 1, flow: 0, em: 1, mode: 0, ltn: 0, aur: 1, term: 0.12, halo: 1.09, haze: 0.16, bk: 0.12, det: 90, da: 0.7, rim: 0.5, gain: 1, ring: 0.12 },
  desert:  { b: 5, cloud: 0.5, spec: 0.25, bump: 1, flow: 0, em: 1, mode: 0, ltn: 0, aur: 0, term: 0.07, halo: 1.055, haze: 0.1, bk: 0.12, det: 110, da: 1, rim: 0.7, gain: 1, ring: 0.15 },
  shatter: { b: 6, cloud: 0, spec: 0, bump: 1.1, flow: 0, em: 0.7, mode: 2, ltn: 0, aur: 0, term: 0.015, halo: 0, haze: 0, bk: 0.14, det: 110, da: 1, rim: 1, gain: 1.15, ring: 1 },
};
const THEME_BIAS = {
  nebula: { stars: ['blue', 'white', 'yellow'], binary: 0.45, planets: ['gas', 'ice', 'ocean', 'gas', 'desert'] },
  void: { stars: ['white', 'red', 'yellow'], binary: 0.15, planets: ['rock', 'gas', 'rock', 'ice', 'desert'] },
  ember: { stars: ['red', 'orange', 'orange'], binary: 0.2, planets: ['lava', 'rock', 'gas', 'lava', 'desert'] },
  ion: { stars: ['blue', 'blue', 'white'], binary: 0.5, planets: ['gas', 'ice', 'gas', 'ocean', 'rock'] },
  verdant: { stars: ['yellow', 'white', 'yellow'], binary: 0.2, planets: ['ocean', 'gas', 'ocean', 'desert', 'rock'] },
  crimson: { stars: ['red', 'orange', 'white'], binary: 0.4, planets: ['lava', 'gas', 'desert', 'rock', 'gas'] },
  amber: { stars: ['yellow', 'orange', 'yellow'], binary: 0.25, planets: ['gas', 'desert', 'gas', 'ocean', 'rock'] },
  frost: { stars: ['blue', 'white', 'white'], binary: 0.3, planets: ['ice', 'gas', 'ice', 'rock', 'ocean'] },
};
const DEFAULT_THEME = { name: 'nebula', hue: 268, hueJit: 40, sat: 46, smudge: 6, smudgeA: 1.5, stars: 700, starBright: 1.0 };

// palette keys that crossfade continuously (Color or number)
const PAL_COLORS = ['base', 'nebA', 'nebB', 'nebC', 'gal', 'haze', 'fog', 'fog2', 'rail', 'grid', 'dust', 'sunCol', 'sun2Col', 'keyCol', 'ambCol'];
const PAL_NUMS = ['nebAmt', 'fogDens', 'starBright', 'sunR', 'sunI', 'sun2R', 'sun2I'];

export class Env3D {
  constructor(THREE, scene, opts = {}) {
    this.THREE = THREE;
    this.scene = scene;
    const q = this.quality = opts.quality ?? 1;
    const lo = this.lo = q < 0.75;
    this.opts = {
      lightGain: opts.lightGain ?? 0.085,     // how strongly state.lights glow in the fog
      laneLightGain: opts.laneLightGain ?? 1,
      fieldDim: opts.fieldDim ?? 0.4,        // backdrop dimming behind the play field (readability)
      autoLightning: opts.autoLightning ?? true,
      planets: opts.planets ?? true,
      fogLayers: opts.fogLayers ?? null,     // override the number of fog sheets (default 3, or 2 at quality < 0.75)
      viewH: opts.viewH ?? 0,
      keyElevation: opts.keyElevation ?? 0.8, // rad: how high the key light sits (the drawn sun itself is on the horizon)
      autoEvents: opts.autoEvents ?? true,   // ambient events schedule themselves (env.event(name) works either way)
      eventRate: opts.eventRate ?? 1,        // scheduler speed (2 = twice as often)
      planetRes: opts.planetRes ?? 1,        // scales the baked planet cube maps (1024 / 512 / 256 px at quality 1, halved below 0.75)
      bakeBudget: opts.bakeBudget ?? (q < 0.75 ? 80000 : 200000), // planet texels baked per frame after a sector change
      firstBake: opts.firstBake ?? true,     // bake the camera-facing planet synchronously in the very first update (menu / first frame)
      planetTypes: opts.planetTypes || null, // debug: force types per slot, e.g. ['ocean', 'gas', null]
      special: opts.special || null,         // debug: 'twin' | 'shatter' | 'hotjup'
      specialSlot: opts.specialSlot ?? 1,
      rings: opts.rings,                     // debug: true / false forces rings on / off
      shipDepth: opts.shipDepth ?? true,     // far hulls resolve their own occlusion in a far-end sliver of the depth buffer (see SHIP_VS)
      station: opts.station,                 // debug: true / false forces the sector's orbital station on / off
    };
    this._renderer = null; this._ctxEl = null; // bound below (else picked up from the first frame that draws the sky)

    // public lighting outputs
    this.sunDirection = new THREE.Vector3(-0.45, 1, 0.55).normalize(); // key-light direction (drawn sun's azimuth, lifted)
    this.sunSkyDirection = new THREE.Vector3(1, 0, 0);                 // where the sun disc is actually drawn
    this.sunColor = new THREE.Color(1, 0.94, 0.86);
    this.ambientColor = new THREE.Color(0.27, 0.48, 1);

    this.group = new THREE.Group();
    this.group.name = 'Env3D';
    scene.add(this.group);

    this._disposables = [];
    this._rand = makeRng(1234567);
    this._clock = 0;       // s, env time (respects pause / slow-mo)
    this._scroll = 0;      // world units travelled
    this._warpT = 0;
    this._warp = 0; this._ion = 0; this._ecl = 0;
    this._lane = 0; this._laneInit = false;
    this._flash = 0;
    this._boltTimer = 1.5;
    this._fade = 1; this._fadeSwapped = true; this._hasSector = false;
    this._pending = null;
    this._W = 1400; this._H = 790;
    this._keyFrom = new THREE.Vector3(); this._keyTo = new THREE.Vector3().copy(this.sunDirection);
    this._v = new THREE.Vector3(); this._v2 = new THREE.Vector3(); this._v3 = new THREE.Vector3();
    this._c = new THREE.Color(); this._c2 = new THREE.Color();
    this._q = new THREE.Quaternion(); this._q2 = new THREE.Quaternion(); this._qI = new THREE.Quaternion(); this._Y = new THREE.Vector3(0, 1, 0);
    this._cam = null; this._shown = false; this._kick = 0; this._warpHi = false; this._one = { count: 1 };
    this.sector = { level: 1, theme: '', star: '', binary: false, planets: [], twin: -1 };
    this._e = new THREE.Euler(); this._fwd = new THREE.Vector3(1, 0, 0); this._dNear = 0; this._dFar = 1; this._seen = 0; this._ctxLost = false; this._firstDone = false;
    this._m4 = new THREE.Matrix4();

    this._pal = this._newPal(); this._palFrom = this._newPal(); this._palTo = this._newPal();

    // ---- shared uniforms ----
    const V3 = () => new THREE.Vector3();
    const P = this._pal;
    this.U = {
      uNoise: { value: this._makeNoise() },
      uCam: { value: V3() },
      uField: { value: new THREE.Vector4(700, 395, this.opts.fieldDim, 0) },
      uTime: { value: 0 }, uScroll: { value: 0 }, uWarp: { value: 0 }, uWarpT: { value: 0 },
      uIon: { value: 0 }, uEclipse: { value: 0 }, uDip: { value: 1 },
      uPx: { value: 2 / 1080 }, uAspect: { value: 16 / 9 },
      uLP: { value: new Float32Array(MAXL * 4) }, uLC: { value: new Float32Array(MAXL * 4) }, uLN: { value: 0 },
      uFlashP: { value: new THREE.Vector4(0, -1e5, 0, 1) }, uFlashC: { value: new THREE.Color(0, 0, 0) },
      uSunDir: { value: V3().set(1, 0, 0) }, uSunT: { value: V3().set(0, 0, 1) }, uSunB: { value: V3().set(0, 1, 0) },
      uSunCol: { value: P.sunCol }, uSun2Dir: { value: V3().set(1, 0, 0) }, uSun2Col: { value: P.sun2Col },
      uSeed: { value: V3() },
      uPSunCol: { value: new THREE.Color(1, 1, 1) },
    };
    this._defs = { OCT: lo ? 3 : 4, FOCT: lo ? 2 : 3, NL: lo ? 8 : MAXL };
    if (lo) this._defs.LITE = 1;

    this._buildSky();
    this._buildStars();
    this._buildPlanets();
    this._buildFog();
    this._buildLane();
    this._buildDust();
    this._buildBolts();
    this._buildComet();
    this._buildEventGfx();
    this._buildEvents();

    if (opts.renderer) this._bind(opts.renderer);
    this.setSector(opts.level ?? 1, opts.theme ?? null);
  }

  /* --------------------------------- builders -------------------------------- */

  _mat(p) {
    const THREE = this.THREE;
    const m = new THREE.ShaderMaterial({
      // NOT `transparent`: three draws the transparent list after every opaque
      // object, and with depthTest off we would paint over the hulls. Staying in
      // the opaque list (blending still applies to non-Normal modes) + negative
      // renderOrder puts the whole environment strictly before gameplay.
      depthWrite: false, depthTest: false, transparent: false,
      defines: { ...this._defs, ...(p.defines || {}) },
      uniforms: p.uniforms, vertexShader: p.vs, fragmentShader: p.fs,
      side: p.side ?? THREE.FrontSide,
      blending: p.blending ?? THREE.AdditiveBlending,
    });
    if (m.blending === THREE.NormalBlending) { // classic alpha blend, spelled out (see above)
      m.blending = THREE.CustomBlending;
      m.blendEquation = THREE.AddEquation;
      m.blendSrc = THREE.SrcAlphaFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor;
      m.blendSrcAlpha = THREE.OneFactor; m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    }
    if (p.premult) {
      m.blending = THREE.CustomBlending;
      m.blendEquation = THREE.AddEquation;
      m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor;
      m.blendSrcAlpha = THREE.OneFactor; m.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    }
    this._disposables.push(m);
    return m;
  }

  _mesh(geo, mat, ro) {
    const m = new this.THREE.Mesh(geo, mat);
    m.frustumCulled = false;
    m.renderOrder = ro;
    m.matrixAutoUpdate = true;
    this.group.add(m);
    return m;
  }

  _geo(g) { this._disposables.push(g); return g; }

  _makeNoise() {
    const THREE = this.THREE, N = 32;
    const data = new Uint8Array(N * N * N * 4);
    const R = makeRng(90210);
    for (let i = 0; i < data.length; i++) data[i] = (R() * 256) | 0;
    const t = new THREE.Data3DTexture(data, N, N, N);
    t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType;
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
    t.unpackAlignment = 1;
    t.needsUpdate = true;
    this._disposables.push(t);
    return t;
  }

  _newPal() {
    const C = this.THREE.Color, p = {};
    for (const k of PAL_COLORS) p[k] = new C(0, 0, 0);
    for (const k of PAL_NUMS) p[k] = 0;
    return p;
  }

  _buildSky() {
    const THREE = this.THREE, U = this.U, P = this._pal;
    this.skyU = {
      uNoise: U.uNoise, uCam: U.uCam, uField: U.uField, uTime: U.uTime, uWarp: U.uWarp, uWarpT: U.uWarpT,
      uEclipse: U.uEclipse, uIon: U.uIon, uDip: U.uDip, uSeed: U.uSeed,
      uBase: { value: P.base }, uNebA: { value: P.nebA }, uNebB: { value: P.nebB }, uNebC: { value: P.nebC },
      uGalCol: { value: P.gal }, uHaze: { value: P.haze }, uGalN: { value: new THREE.Vector3(0, 1, 0) },
      uNebAmt: { value: 1 },
      uSunDir: U.uSunDir, uSunT: U.uSunT, uSunB: U.uSunB, uSunCol: U.uSunCol, uSun2Dir: U.uSun2Dir, uSun2Col: U.uSun2Col,
      uSun: { value: new THREE.Vector4(0.03, 1, 0.02, 0) },
      uSkyFlash: { value: new THREE.Color(0, 0, 0) },
      uFlare: { value: new THREE.Vector4(0, 0, 0.35, 1) }, uGlowD: { value: new THREE.Vector4(1, 0, 0, 8) }, uGlowC: { value: new THREE.Color(0, 0, 0) },
      uGlowD2: { value: new THREE.Vector4(1, 0, 0, 8) }, uGlowC2: { value: new THREE.Color(0, 0, 0) },
    };
    const mat = this._mat({ uniforms: this.skyU, vs: SKY_VS, fs: SKY_FS, side: THREE.BackSide, blending: THREE.NoBlending, defines: { WARP: 1 } });
    this.sky = this._mesh(this._geo(new THREE.IcosahedronGeometry(1, 2)), mat, RO.sky);
    this.sky.onBeforeRender = (r) => { if (!this._renderer) this._bind(r); };
  }

  _buildStars() {
    const THREE = this.THREE, U = this.U;
    const N = this.lo ? 1700 : 4200;
    const R = makeRng(777);
    const dir = new Float32Array(N * 3), data = new Float32Array(N * 4), col = new Float32Array(N * 3);
    const tints = [[0.75, 0.84, 1], [1, 0.95, 0.88], [1, 0.82, 0.62], [0.62, 0.74, 1], [1, 0.68, 0.5], [0.95, 0.97, 1]];
    const gauss = () => (R() + R() + R() + R() - 2) * 0.5;
    for (let i = 0; i < N; i++) {
      let x, y, z;
      if (R() < 0.42) { // galactic band (local equator)
        const a = R() * Math.PI * 2; y = gauss() * 0.2; const r = Math.sqrt(Math.max(0, 1 - y * y));
        x = Math.cos(a) * r; z = Math.sin(a) * r;
      } else {
        y = R() * 2 - 1; const a = R() * Math.PI * 2, r = Math.sqrt(1 - y * y);
        x = Math.cos(a) * r; z = Math.sin(a) * r;
      }
      dir[i * 3] = x; dir[i * 3 + 1] = y; dir[i * 3 + 2] = z;
      const m = Math.pow(R(), 5.5);                 // magnitude: mostly faint
      const glint = i < (this.lo ? 6 : 12) ? 1 : 0;
      const mm = glint ? 0.75 + R() * 0.25 : m;
      data[i * 4] = 1.5 + mm * 2.6;                 // half-size px (gaussian core is ~1/3 of it)
      data[i * 4 + 1] = R();
      data[i * 4 + 2] = glint ? 0 : R();            // rank — density trim per sector
      data[i * 4 + 3] = glint;
      const t = tints[(R() * tints.length) | 0];
      const b = glint ? 1.5 + R() * 0.9 : 0.1 + mm * 1.5;
      col[i * 3] = t[0] * b; col[i * 3 + 1] = t[1] * b; col[i * 3 + 2] = t[2] * b;
    }
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.setAttribute('aDir', new THREE.InstancedBufferAttribute(dir, 3));
    geo.setAttribute('aData', new THREE.InstancedBufferAttribute(data, 4));
    geo.setAttribute('aCol', new THREE.InstancedBufferAttribute(col, 3));
    geo.instanceCount = N;
    this.starU = {
      uCam: U.uCam, uField: U.uField, uTime: U.uTime, uPx: U.uPx, uAspect: U.uAspect,
      uRot: { value: new THREE.Matrix3() }, uStreak: { value: 0 }, uCount: { value: 1 }, uBright: { value: 1 },
    };
    this.stars = this._mesh(this._geo(geo), this._mat({ uniforms: this.starU, vs: STAR_VS, fs: STAR_FS }), RO.stars);
  }

  _buildPlanets() {
    const THREE = this.THREE, U = this.U, lo = this.lo;
    this.planets = []; this.surfaces = []; this._order = [];
    this._bk = { cur: -1, pass: 0, face: 0, row: 0 };
    this._sunPos = new THREE.Vector3(5200, 0, 0);
    if (!this.opts.planets) return;
    const sphere = this._geo(new THREE.SphereGeometry(1, lo ? 48 : 96, lo ? 32 : 64));
    const ringGeo = this._geo(new THREE.RingGeometry(1, 2, lo ? 96 : 160, 1));
    const V3 = () => new THREE.Vector3(), V4 = (x = 0, y = 0, z = 0, w = 0) => new THREE.Vector4(x, y, z, w), C = () => new THREE.Color();
    this._ringTex = this._makeRingTex();

    // baked surfaces: [albedo res, relief/cloud res]. 0 = the TOP backdrop (fills half the screen),
    // 1 = the horizon planet, 2 = the side planet, 3 = twin companion (lazy), 4–5 = the moon pool
    const k = (lo ? 0.5 : 1) * (this.opts.planetRes || 1);
    const sz = [[1024, 512], [512, 256], [512, 256], [512, 256], [256, 128], [256, 128]];
    for (const s of sz) {
      this.surfaces.push({
        nA: Math.max(64, Math.round(s[0] * k)), nB: Math.max(32, Math.round(s[1] * k)), A: null, B: null, ready: false, pending: false,
        live: false, job: { type: 0, seed: V3(), c: [C(), C(), C(), C()], pr: V4(), pr2: V4() },
      });
    }
    // the baker: a full-screen quad rendered into cube faces, a strip at a time
    this._bakeU = {
      uFace: { value: 0 }, uPass: { value: 0 }, uType: { value: 0 }, uSeedP: { value: V3() }, uEps: { value: 0.004 },
      uC1: { value: C() }, uC2: { value: C() }, uC3: { value: C() }, uC4: { value: C() }, uPr: { value: V4() }, uPr2: { value: V4() },
    };
    const bm = new THREE.ShaderMaterial({ uniforms: this._bakeU, vertexShader: BAKE_VS, fragmentShader: BAKE_FS, depthTest: false, depthWrite: false, blending: THREE.NoBlending });
    this._disposables.push(bm);
    this._bakeScene = new THREE.Scene();
    this._bakeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quad = new THREE.Mesh(this._geo(new THREE.PlaneGeometry(2, 2)), bm);
    quad.frustumCulled = false;
    this._bakeScene.add(quad);

    const body = (sun) => {
      const u = {
        uNoise: U.uNoise, uCam: U.uCam, uField: U.uField, uTime: U.uTime, uEclipse: U.uEclipse, uSunCol: U.uPSunCol,
        uRingTex: { value: this._ringTex }, uMapA: { value: null }, uMapB: { value: null },
        uSunDir: sun, uSunO: { value: V3().set(1, 0, 0) }, uAmb: { value: C() },
        uAtm: { value: C() }, uSunset: { value: C() }, uEmCol: { value: C() }, uCloudCol: { value: C() }, uAurCol: { value: C() },
        uRingN: { value: V3().set(0, 1, 0) }, uP: { value: V4() }, uP2: { value: V4() }, uP3: { value: V4() }, uRot: { value: V4() },
        uP4: { value: V4(1, 1, 0, 0) }, uRingP: { value: V4() }, uImp: { value: V4(1, 0, 0, -1) }, uMoonS: { value: [V4(), V4()] },
        uOp: { value: 0 }, uGain: { value: 0.5 },
      };
      const mesh = this._mesh(sphere, this._mat({ uniforms: u, vs: PLANET_VS, fs: PLANET_FS, blending: THREE.NormalBlending }), RO.planet);
      mesh.visible = false;
      return { mesh, u, T: null, type: '', surf: null, cloudA: 0, cloudV: 0, flowT: 0, flowV: 0 };
    };
    const nMoons = lo ? [1, 1, 0] : [2, 2, 1];
    for (let i = 0; i < 3; i++) {
      const sun = { value: V3().set(1, 0, 0) };
      const b = body(sun);
      const hu = { uCam: U.uCam, uField: U.uField, uSunDir: sun, uEclipse: U.uEclipse, uAtm: b.u.uAtm, uSunset: b.u.uSunset, uOp: b.u.uOp, uGain: { value: 1 }, uLimb: { value: 0.45 } };
      const halo = this._mesh(sphere, this._mat({ uniforms: hu, vs: PLANET_VS, fs: HALO_FS, side: THREE.BackSide }), RO.planet);
      const ru = {
        uNoise: U.uNoise, uCam: U.uCam, uField: U.uField, uSunDir: sun, uSunCol: U.uPSunCol, uEclipse: U.uEclipse, uTime: U.uTime,
        uRingTex: { value: this._ringTex }, uRingCol: { value: C() }, uPC: { value: V3() }, uSeedP: { value: V3() }, uPR: { value: 1 }, uOp: b.u.uOp,
        uGain: { value: 0.5 }, uR0: { value: 1 }, uR1: { value: 2 }, uRingQ: { value: V4() },
      };
      const ring = this._mesh(ringGeo, this._mat({ uniforms: ru, vs: PLANET_VS, fs: RING_FS, side: THREE.DoubleSide, blending: THREE.NormalBlending }), RO.planet);
      halo.visible = ring.visible = false;
      const moons = [];
      for (let m = 0; m < nMoons[i]; m++) {
        const mb = body(sun);
        moons.push({ body: mb, on: false, R: 1, D: 3, a: 0, v: 0.05, spin: 0, e1: V3(), e2: V3(), pos: V3(), gain: 0.5, twin: false });
      }
      this.planets.push({
        on: false, body: b, halo, hu, ring, ru, moons, sun: sun.value, hasRing: false, hasHalo: false, slot: i,
        pos: V3(), R: 1, spin: 0, spinV: 0, drift: 0, qTilt: new THREE.Quaternion(), axis: V3().set(0, 1, 0), haloS: 1.1,
        ringIn: 1.3, ringOut: 2.2, dist: 0, op: 0, imp: -1, aur: 0, aurBoost: 0, gain: 0.5, type: '',
      });
    }
    this._order = this.planets.slice();
  }

  // 8 radial ring profiles (rgb tint, a = optical depth): fine bands, gaps, a debris row
  _makeRingTex() {
    const THREE = this.THREE, W = 1024, H = 8;
    const data = new Uint8Array(W * H * 4);
    for (let row = 0; row < H; row++) {
      const R = makeRng(row * 977 + 31);
      const tab = (n) => { const a = new Float32Array(n + 2); for (let i = 0; i < a.length; i++) a[i] = R(); return a; };
      const oct = [tab(7), tab(23), tab(71), tab(211), tab(520)];
      const amp = [0.9, 0.7, 0.55, 0.4, 0.3];
      const nz = (o, t) => { const a = oct[o], x = t * (a.length - 2), i = x | 0, f = x - i, s = f * f * (3 - 2 * f); return a[i] + (a[i + 1] - a[i]) * s; };
      const debris = row === 7;
      const gaps = [];
      for (let g = 0, n = debris ? 1 : 2 + ((R() * 4) | 0); g < n; g++) gaps.push(0.12 + R() * 0.78, 0.006 + R() * R() * 0.035);
      const b0 = 0.12 + R() * 0.14, b1 = 0.5 + R() * 0.14, cg = b1 + 0.015 + R() * 0.03, a1 = 0.84 + R() * 0.1;
      const warm = [1, 0.86 + R() * 0.08, 0.66 + R() * 0.14], cool = [0.8 + R() * 0.1, 0.88, 1];
      for (let x = 0; x < W; x++) {
        const t = x / (W - 1);
        let d = 0.5;
        for (let o = 0; o < 5; o++) d += (nz(o, t) - 0.5) * amp[o];
        // C ring (thin), B ring (dense), division, A ring, ragged outer edge
        let env = t < b0 ? 0.22 + 0.3 * t / b0 : t < b1 ? 0.95 : t < cg ? 0.04 : t < a1 ? 0.62 : 0.25 * Math.max(0, 1 - (t - a1) / (1 - a1));
        if (debris) env = 0.5 * Math.sin(Math.PI * t) ** 0.6;
        d = clamp01(d * 1.15 - 0.08) * env;
        for (let g = 0; g < gaps.length; g += 2) { const q = Math.abs(t - gaps[g]) / gaps[g + 1]; if (q < 1) d *= 0.06 + 0.94 * q * q * q; }
        const m = clamp01(t * 1.1 + (nz(1, t) - 0.5) * 0.5), v = 0.72 + 0.5 * nz(2, t), o = (row * W + x) * 4;
        data[o] = 255 * clamp01((warm[0] + (cool[0] - warm[0]) * m) * v);
        data[o + 1] = 255 * clamp01((warm[1] + (cool[1] - warm[1]) * m) * v);
        data[o + 2] = 255 * clamp01((warm[2] + (cool[2] - warm[2]) * m) * v);
        data[o + 3] = 255 * clamp01(d);
      }
    }
    const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    this._disposables.push(t);
    return t;
  }

  _surfRT(s) {
    if (s.A) return;
    const THREE = this.THREE;
    const mk = (n) => {
      const rt = new THREE.WebGLCubeRenderTarget(n, {
        type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
        minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
      });
      this._disposables.push(rt);
      return rt;
    };
    s.A = mk(s.nA); s.B = mk(s.nB);
  }

  // Bake pending planet surfaces, `budget` texel-costs per call (so a sector
  // change never hitches); bodies fade in when their surface is done.
  // maxSurf: stop after that many surfaces have been completed.
  _bakeStep(budget, maxSurf = Infinity) {
    const r = this._renderer, bk = this._bk, S = this.surfaces;
    if (!r || !S.length || this._ctxLost) return;
    const gl = r.getContext && r.getContext();
    if (gl && gl.isContextLost && gl.isContextLost()) { this._ctxLost = true; return; }   // rebake() runs when it comes back
    if (bk.cur < 0) {
      bk.cur = this._nextBake();
      if (bk.cur < 0) return;
      bk.pass = 0; bk.face = 0; bk.row = 0;
    }
    const prevRT = r.getRenderTarget(), prevFace = r.getActiveCubeFace(), prevMip = r.getActiveMipmapLevel(), prevAC = r.autoClear;
    const xr = r.xr && r.xr.enabled; if (xr) r.xr.enabled = false;
    r.autoClear = false;
    const u = this._bakeU;
    try {
      while (budget > 0 && maxSurf > 0 && bk.cur >= 0) {
        const s = S[bk.cur], j = s.job;
        this._surfRT(s);
        const rt = bk.pass ? s.B : s.A, n = bk.pass ? s.nB : s.nA, cost = bk.pass ? 3 : 1;
        const rows = Math.min(n - bk.row, Math.max(8, Math.floor(budget / (n * cost))));
        const lastStrip = bk.face === 5 && bk.row + rows >= n;
        rt.texture.generateMipmaps = lastStrip; // one mip chain per map, after its final strip
        u.uFace.value = bk.face; u.uPass.value = bk.pass; u.uType.value = j.type; u.uEps.value = 2.5 / s.nB;
        u.uSeedP.value.copy(j.seed); u.uPr.value.copy(j.pr); u.uPr2.value.copy(j.pr2);
        u.uC1.value.copy(j.c[0]); u.uC2.value.copy(j.c[1]); u.uC3.value.copy(j.c[2]); u.uC4.value.copy(j.c[3]);
        rt.viewport.set(0, 0, n, n); rt.scissor.set(0, bk.row, n, rows); rt.scissorTest = true;
        r.setRenderTarget(rt, bk.face);
        r.render(this._bakeScene, this._bakeCam);
        budget -= rows * n * cost;
        bk.row += rows;
        if (bk.row >= n) { bk.row = 0; bk.face++; }
        if (bk.face > 5) {
          bk.face = 0;
          if (bk.pass === 0) bk.pass = 1;
          else {
            s.pending = false; s.ready = true; bk.pass = 0; this._shown = true; maxSurf--;
            bk.cur = this._nextBake();
          }
        }
      }
    } finally {
      r.setRenderTarget(prevRT, prevFace, prevMip);
      r.autoClear = prevAC;
      if (xr) r.xr.enabled = true;
    }
  }

  // the planet the current camera is looking at goes first
  _nextBake() {
    const S = this.surfaces, ord = this._view === 2 ? BAKE_ORDER_H : BAKE_ORDER_T;
    for (let i = 0; i < ord.length; i++) if (S[ord[i]] && S[ord[i]].pending) return ord[i];
    return -1;
  }

  /** True once every planet surface of the current sector is baked. */
  get ready() {
    for (const s of this.surfaces) if (s.pending) return false;
    return this._fade >= 1;
  }

  /** 0…1: how much of the current sector's planet surfaces is baked. */
  get bakeProgress() {
    let live = 0, done = 0;
    for (const s of this.surfaces) if (s.live) { live++; if (!s.pending) done++; }
    const bk = this._bk;
    if (bk.cur >= 0 && live) done += (bk.pass * 0.5 + (bk.face + bk.row / (bk.pass ? this.surfaces[bk.cur].nB : this.surfaces[bk.cur].nA)) / 12);
    return live ? Math.min(1, done / live) : 1;
  }

  /**
   * Bake planet surfaces ahead of time (behind a loading / start screen, before a screenshot).
   *   prewarm(renderer)            everything that is pending, in one go (≈ 20 M texel-costs: a visible hitch)
   *   prewarm(renderer, budget)    at most `budget` texel-costs per call — call it once a frame until it returns
   *                                true (300 000 ≈ 1–2 ms on a desktop GPU); `bakeProgress` is the 0…1 progress
   * Surfaces that are finished before the environment is first drawn appear at once, without the fade-in.
   * The camera-facing planet of the last known view goes first. Returns `ready`.
   */
  prewarm(renderer, budget = Infinity) {
    if (renderer) this._bind(renderer);
    if (this._fade < 1 && !this._fadeSwapped) { this._fadeSwapped = true; this._applySector(); }
    this._bakeStep(budget);
    return this.ready;
  }

  /**
   * Re-bake the planet surfaces of the current sector (their cube maps are render targets: after a
   * WebGL context loss they come back empty). Called automatically on `webglcontextrestored` of the
   * renderer's canvas; call it yourself if you restore a context by other means. Planets fade back in.
   */
  rebake() {
    this._ctxLost = false;
    this._bk.cur = -1;
    for (const s of this.surfaces) if (s.live) { s.pending = true; s.ready = false; }
  }

  _bind(r) {
    if (this._renderer === r && this._ctxEl) return;
    this._unbind();
    this._renderer = r;
    const el = r && r.domElement;
    if (!el || !el.addEventListener) return;
    this._ctxEl = el;
    this._onLost = this._onLost || (() => { this._ctxLost = true; });
    this._onRestored = this._onRestored || (() => { this.rebake(); });
    el.addEventListener('webglcontextlost', this._onLost);
    el.addEventListener('webglcontextrestored', this._onRestored);
  }

  _unbind() {
    if (this._ctxEl) { this._ctxEl.removeEventListener('webglcontextlost', this._onLost); this._ctxEl.removeEventListener('webglcontextrestored', this._onRestored); }
    this._ctxEl = null;
  }

  _buildEventGfx() {
    const THREE = this.THREE, U = this.U;
    // ---- blips ----
    const NB = this.NB = this.lo ? 128 : 256;
    const quad = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
    let geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(quad, 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this._bP = new Float32Array(NB * 4); this._bQ = new Float32Array(NB * 4); this._bK = new Float32Array(NB * 4);
    const dyn = (arr, n) => { const a = new THREE.InstancedBufferAttribute(arr, n); a.setUsage(THREE.DynamicDrawUsage); return a; };
    geo.setAttribute('aP', dyn(this._bP, 4)); geo.setAttribute('aQ', dyn(this._bQ, 4)); geo.setAttribute('aK', dyn(this._bK, 4));
    geo.instanceCount = 0;
    this._blipGeo = this._geo(geo);
    this.blips = this._mesh(geo, this._mat({ uniforms: { uCam: U.uCam, uField: U.uField, uPx: U.uPx, uAspect: U.uAspect }, vs: BLIP_VS, fs: BLIP_FS }), RO.blip);
    this.blips.visible = false;
    this._nb = 0;

    // ---- ship kit (see SHIP_VS). Parts are listed bottom-up, so that even without depth
    // (opts.shipDepth = false) later triangles paint over earlier ones correctly from above ----
    const pos = [], nor = [], mdl = [], colr = [];
    let M = 0, K = 0, C = [0.3, 0.32, 0.36], CE = null;      // model, kind, colour, colour of the -x end (gradients)
    const tri = (a, b, c2, ca, cb, cc) => {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c2[0] - a[0], vy = c2[1] - a[1], vz = c2[2] - a[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c2[0], c2[1], c2[2]); nor.push(nx, ny, nz, nx, ny, nz, nx, ny, nz); mdl.push(M, K, M, K, M, K);
      colr.push(ca[0], ca[1], ca[2], cb[0], cb[1], cb[2], cc[0], cc[1], cc[2]);
    };
    const quadC = (a, b, c2, d) => { tri(a, b, c2, a.c, b.c, c2.c); tri(a, c2, d, a.c, c2.c, d.c); };
    // box x0..x1, y0..y1, z0..z1; the +x end is scaled by (ty, tz) about the box axis and shifted by (dy, dz);
    // optional yaw about the Y axis through the origin
    const B = (x0, x1, y0, y1, z0, z1, ty = 1, tz = 1, yaw = 0, dy = 0, dz = 0) => {
      const cy = (y0 + y1) / 2, cz = (z0 + z1) / 2, cs = Math.cos(yaw), sn = Math.sin(yaw);
      const P = (fx, fy, fz) => {
        const x = fx ? x1 : x0; let y = fy ? y1 : y0, z = fz ? z1 : z0;
        if (fx) { y = cy + (y - cy) * ty + dy; z = cz + (z - cz) * tz + dz; }
        const v = [x * cs + z * sn, y, z * cs - x * sn]; v.c = fx || !CE ? C : CE; return v;
      };
      const flip = (x1 - x0) * (y1 - y0) * (z1 - z0) < 0;
      const q = flip ? (a, b, c2, d) => quadC(a, d, c2, b) : quadC;
      q(P(0, 0, 0), P(1, 0, 0), P(1, 0, 1), P(0, 0, 1));           // bottom
      q(P(0, 0, 0), P(0, 0, 1), P(0, 1, 1), P(0, 1, 0));           // stern
      q(P(1, 0, 0), P(1, 1, 0), P(1, 1, 1), P(1, 0, 1));           // bow
      q(P(0, 0, 0), P(0, 1, 0), P(1, 1, 0), P(1, 0, 0));           // -z side
      q(P(0, 0, 1), P(1, 0, 1), P(1, 1, 1), P(0, 1, 1));           // +z side
      q(P(0, 1, 0), P(0, 1, 1), P(1, 1, 1), P(1, 1, 0));           // top
    };
    // the same box on both sides of the centre line (z0, z1 > 0; a z shift is mirrored too)
    const S = (x0, x1, y0, y1, z0, z1, ty = 1, tz = 1, dy = 0, dz = 0) => { B(x0, x1, y0, y1, z0, z1, ty, tz, 0, dy, dz); B(x0, x1, y0, y1, -z1, -z0, ty, tz, 0, dy, -dz); };
    // n-gon prism / cone along Y (ax = 0) or along X (ax = 1), radius r0 at a0 → r1 at a1
    const cyl = (ax, a0, a1, r0, r1, n, ou = 0, ov = 0, capK = -1) => {
      const P = (a, r, i) => { const t = (i / n) * Math.PI * 2 + Math.PI / n, u = Math.cos(t) * r + ou, v = Math.sin(t) * r + ov; const p2 = ax ? [a, u, v] : [u, a, -v]; p2.c = a === a0 && CE ? CE : C; return p2; };
      const ctr = (a) => { const p2 = ax ? [a, ou, ov] : [ou, a, -ov]; p2.c = a === a0 && CE ? CE : C; return p2; };
      for (let i = 0; i < n; i++) {
        quadC(P(a0, r0, i), P(a0, r0, i + 1), P(a1, r1, i + 1), P(a1, r1, i));
        const k0 = K; if (capK >= 0) K = capK;
        if (r1 > 1e-4) { const c2 = ctr(a1), p1 = P(a1, r1, i), p2 = P(a1, r1, i + 1); tri(c2, p1, p2, c2.c, p1.c, p2.c); }
        K = k0;
        if (r0 > 1e-4) { const c2 = ctr(a0), p1 = P(a0, r0, i + 1), p2 = P(a0, r0, i); tri(c2, p1, p2, c2.c, p1.c, p2.c); }
      }
    };
    const H1 = [0.3, 0.32, 0.36], H2 = [0.4, 0.42, 0.45], HD = [0.11, 0.12, 0.14], HM = [0.2, 0.215, 0.24];
    const RED = [0.5, 0.07, 0.04], ORG = [0.55, 0.24, 0.04], YEL = [0.5, 0.4, 0.06], TEAL = [0.05, 0.3, 0.32], WHT = [0.6, 0.6, 0.6];
    const ENG = [0.5, 1.3, 3.2], ENGW = [1.6, 2.4, 3.6], ENGR = [3.0, 1.1, 0.25], OFF = [0, 0, 0];
    const k = (kind, c2) => { K = kind; C = c2; CE = null; };
    // an engine: bell, white-hot throat, a tapering plume that fades to nothing
    const engine = (x, y, z, r, len, colE = ENG) => {
      k(6, HD); cyl(1, x - r * 1.1, x, r, r * 0.8, 8, y, z);
      K = 2; C = ENGW; cyl(1, x - r * 1.12, x - r * 1.1, r * 0.82, r * 0.82, 8, y, z);
      C = colE; CE = OFF; cyl(1, x - r * 1.1 - len, x - r * 1.1, r * 0.25, r * 0.8, 6, y, z); CE = null;
    };

    /* ---- 0: freighter — spine, container racks, command module, engine block ---- */
    M = 0;
    k(6, HD); B(-0.4, 0.36, -0.014, 0.014, -0.014, 0.014);
    for (let i = 0; i < 6; i++) S(-0.345 + i * 0.118, -0.337 + i * 0.118, -0.03, 0.045, 0.0, 0.03);            // rack frames
    const CC = [RED, TEAL, H2, ORG, HM, YEL, H1, TEAL, RED, WHT, ORG, HM];
    for (let i = 0; i < 6; i++) {
      const x0 = -0.335 + i * 0.118;
      k(0, CC[(i * 5 + 1) % 12]); B(x0, x0 + 0.104, -0.05, -0.003, 0.016, 0.082); k(0, CC[(i * 3 + 4) % 12]); B(x0, x0 + 0.104, -0.05, -0.003, -0.082, -0.016);
      if (i !== 2) { k(0, CC[(i * 7 + 2) % 12]); B(x0, x0 + 0.104, 0.003, 0.046, 0.016, 0.076); }
      if (i !== 4) { k(0, CC[(i * 2 + 7) % 12]); B(x0, x0 + 0.104, 0.003, 0.046, -0.076, -0.016); }
    }
    k(0, H1); B(-0.5, -0.38, -0.05, 0.045, -0.07, 0.07);                                                      // engine block
    k(0, HM); B(-0.47, -0.4, 0.045, 0.07, -0.045, 0.045, 0.8, 0.8);
    k(6, HD); S(-0.48, -0.41, -0.004, 0.004, 0.07, 0.17, 1, 0.7);                                             // radiators
    k(3, ENGR); S(-0.478, -0.412, -0.0045, 0.0045, 0.1, 0.104); S(-0.476, -0.414, -0.0045, 0.0045, 0.135, 0.139);
    engine(-0.5, 0, 0.036, 0.03, 0.09); engine(-0.5, 0, -0.036, 0.03, 0.09);
    k(0, H2); B(0.35, 0.5, -0.04, 0.032, -0.052, 0.052, 0.5, 0.45);                                           // command module
    k(0, H1); B(0.36, 0.44, 0.032, 0.052, -0.03, 0.03, 0.6, 0.7);
    k(1, H1); B(0.44, 0.48, 0.004, 0.02, -0.036, 0.036, 0.7, 0.75); S(0.37, 0.46, -0.004, 0.012, 0.0525, 0.0535, 0.5, 1, 0, -0.022);
    k(6, HD); B(-0.44, -0.435, 0.07, 0.13, -0.003, 0.003); B(0.38, 0.384, 0.052, 0.09, -0.002, 0.002);

    /* ---- 1: frigate — arrowhead hull, swept wings with nacelles, bridge, dorsal fin ---- */
    M = 1;
    k(6, HD); B(-0.3, 0.22, -0.065, -0.028, -0.014, 0.014, 0.3, 1);                                           // keel
    k(0, H1); B(-0.42, 0.1, -0.03, 0.02, -0.072, 0.072, 0.75, 0.72);
    B(0.1, 0.5, -0.024, 0.014, -0.052, 0.052, 0.3, 0.1);
    k(0, HM); S(-0.44, -0.12, -0.012, 0.006, 0.07, 0.21, 0.6, 0.2, 0, -0.085);                                // swept wings
    k(0, RED); S(-0.4, -0.32, 0.004, 0.0085, 0.11, 0.19, 1, 0.75, 0, -0.022);                                  // wing flashes
    k(0, H2); S(-0.5, -0.22, -0.032, 0.022, 0.185, 0.235, 0.6, 0.6);                                          // nacelles
    engine(-0.5, -0.005, 0.21, 0.022, 0.1); engine(-0.5, -0.005, -0.21, 0.022, 0.1); engine(-0.42, -0.004, 0, 0.03, 0.12);
    k(0, H2); B(-0.36, 0.06, 0.02, 0.04, -0.045, 0.045, 0.7, 0.5);
    k(0, H1); B(-0.27, -0.08, 0.04, 0.066, -0.03, 0.03, 0.6, 0.6);                                            // bridge
    k(1, H1); B(-0.085, -0.055, 0.042, 0.058, -0.02, 0.02, 0.7, 0.8); S(-0.26, -0.1, 0.046, 0.058, 0.0295, 0.0305, 0.6, 1, 0, -0.011);
    k(0, HM); B(-0.42, -0.27, 0.02, 0.12, -0.005, 0.005, 0.35, 1, 0, 0.02);                                   // fin
    k(6, HD); B(0.1, 0.15, 0.014, 0.03, -0.016, 0.016); S(0.14, 0.26, 0.019, 0.025, 0.005, 0.009);            // turret + barrels
    k(3, [2.2, 0.3, 0.2]); B(0.2, 0.36, 0.0142, 0.0152, -0.004, 0.004, 0.3, 0.5);

    /* ---- 6: raider cruiser — the other fleet: a trident, prongs forward ---- */
    M = 6;
    k(6, HD); B(-0.36, 0.1, -0.06, -0.03, -0.03, 0.03, 0.4, 0.5);
    k(0, HM); B(-0.42, 0.22, -0.034, 0.024, -0.062, 0.062, 0.5, 0.35);                                        // core hull
    k(0, H1); S(-0.3, 0.02, -0.012, 0.008, 0.05, 0.13, 0.7, 0.6, 0, 0.015);                                   // pylons
    k(0, HM); S(-0.2, 0.5, -0.024, 0.016, 0.105, 0.155, 0.35, 0.3, 0, -0.03);                                 // prongs
    k(3, [3.0, 0.5, 0.12]); S(-0.1, 0.42, 0.0162, 0.0172, 0.122, 0.13, 0.3, 0.5, -0.013, -0.026);
    k(0, H1); B(-0.5, -0.38, -0.046, 0.036, -0.11, 0.11, 1, 0.85);                                            // engine block
    engine(-0.5, -0.005, 0.07, 0.026, 0.11, ENGR); engine(-0.5, -0.005, -0.07, 0.026, 0.11, ENGR); engine(-0.5, -0.005, 0, 0.034, 0.14, ENGR);
    k(0, H2); B(-0.34, 0.04, 0.024, 0.046, -0.04, 0.04, 0.6, 0.5);
    k(1, H1); B(-0.2, -0.06, 0.046, 0.06, -0.024, 0.024, 0.6, 0.7);
    k(0, HM); B(-0.4, -0.2, 0.036, 0.13, -0.006, 0.006, 0.25, 1, 0, 0.03); S(-0.44, -0.3, 0.02, 0.09, 0.08, 0.088, 0.3, 1, 0.02, 0.03);

    /* ---- 2: dreadnought — a kilometre of dagger: stepped decks, hangar sponsons, weapon prongs,
            a bridge tower, turret rows, trench, engine bank ---- */
    M = 2;
    k(6, HD); B(-0.45, 0.3, -0.06, -0.034, -0.05, 0.05, 0.4, 0.3);                                            // keel
    B(-0.3, -0.05, -0.085, -0.06, -0.012, 0.012, 0.4, 1);                                                    // ventral fin
    k(0, HM); S(-0.36, 0.04, -0.034, 0.002, 0.1, 0.172, 0.8, 0.55, 0, -0.012);                                // hangar sponsons
    k(0, H1); B(-0.47, -0.16, -0.036, 0.012, -0.118, 0.118);                                                  // stern block
    B(-0.16, 0.17, -0.036, 0.012, -0.118, 0.118, 0.86, 0.6);                                                 // waist
    B(0.17, 0.5, -0.03, 0.0086, -0.0708, 0.0708, 0.42, 0.13);                                                // bow blade
    k(0, HM); S(0.04, 0.4, -0.022, 0.003, 0.086, 0.108, 0.5, 0.5, 0, -0.05);                                  // weapon prongs
    k(6, HD); S(0.36, 0.47, -0.012, -0.004, 0.036, 0.042, 1, 1, 0, -0.012);                                   // prong barrels
    k(6, [0.02, 0.022, 0.03]); S(-0.3, -0.06, 0.0, 0.0045, 0.119, 0.16, 1, 0.7, 0, -0.008);                 // hangar deck recess
    k(3, [1.2, 0.9, 0.45]); S(-0.3, -0.06, 0.003, 0.0065, 0.119, 0.1225); S(-0.3, -0.295, 0.003, 0.0065, 0.1225, 0.158);   // hangar lights
    k(6, HD); B(-0.5, -0.47, -0.042, 0.018, -0.108, 0.108);                                                   // engine bank
    for (let i = -2; i <= 2; i++) engine(-0.5, -0.012, i * 0.042, i === 0 ? 0.021 : 0.017, i === 0 ? 0.12 : 0.085);
    k(0, RED); B(0.19, 0.215, 0.006, 0.0105, -0.066, 0.066, 1, 0.92); S(-0.44, -0.2, 0.01, 0.0145, 0.1, 0.116);          // markings
    k(0, WHT); B(0.3, 0.42, 0.002, 0.0085, -0.004, 0.004, 0.2, 0.5);
    k(1, H1); S(-0.44, 0.16, 0.01, 0.0145, 0.086, 0.094, 1, 1, 0, -0.03); S(-0.45, -0.17, -0.01, 0.004, 0.117, 0.1195);  // window rows along the hull
    S(0.19, 0.46, 0.0088, 0.0098, 0.04, 0.046, 0.5, 0.4, -0.0125, -0.031);
    k(0, H2); B(-0.43, 0.22, 0.012, 0.03, -0.074, 0.074, 0.8, 0.42);                                          // deck 1
    k(6, [0.03, 0.033, 0.04]); B(-0.1, 0.2, 0.028, 0.032, -0.01, 0.01, 1, 0.6);                             // trench
    k(3, [0.3, 0.9, 1.6]); B(-0.1, 0.2, 0.03, 0.0335, -0.0015, 0.0015);
    for (let i = 0; i < 7; i++) {                                                                             // turret rows
      const x = -0.4 + i * 0.085, z = 0.058 - Math.max(0, i - 3) * 0.006;
      k(0, HM); S(x, x + 0.022, 0.03, 0.04, z - 0.011, z + 0.011, 0.8, 0.8);
      k(6, HD); S(x + 0.02, x + 0.05, 0.034, 0.037, z - 0.006, z - 0.003); S(x + 0.02, x + 0.05, 0.034, 0.037, z + 0.003, z + 0.006);
    }
    k(0, H1); B(-0.38, 0.0, 0.03, 0.05, -0.04, 0.04, 0.8, 0.55);                                              // deck 2
    k(1, H1); S(-0.37, -0.02, 0.036, 0.046, 0.0398, 0.0408, 0.8, 1, 0, -0.018);
    k(0, H2); B(-0.33, -0.18, 0.05, 0.09, -0.028, 0.028, 0.8, 0.7);                                           // bridge tower
    k(0, H1); B(-0.3, -0.22, 0.09, 0.104, -0.052, 0.052, 0.9, 0.6);                                           // bridge wings
    k(1, H1); B(-0.222, -0.214, 0.092, 0.102, -0.03, 0.03); S(-0.32, -0.19, 0.06, 0.082, 0.028, 0.029, 0.8, 1, 0, -0.008);
    k(6, HD); B(-0.285, -0.279, 0.104, 0.17, -0.003, 0.003); B(-0.255, -0.251, 0.104, 0.14, -0.002, 0.002);   // masts
    k(0, HM); B(-0.16, -0.05, 0.05, 0.066, -0.02, 0.02, 0.5, 0.6);
    k(0, H2); cyl(0, 0.05, 0.062, 0.016, 0.012, 8, -0.105, 0); cyl(0, 0.05, 0.058, 0.012, 0.009, 8, 0.03, 0); // sensor domes
    k(3, [2.4, 0.3, 0.25]); B(-0.284, -0.28, 0.17, 0.174, -0.004, 0.004);

    /* ---- 3: station — habitat ring on six spokes, hub with reactor and spire, an inner truss ring,
            three docking arms (one with a ship alongside), solar wings on booms. Ring plane = XZ ---- */
    M = 3;
    const TAU = Math.PI * 2;
    k(6, HD); cyl(0, -0.46, -0.24, 0.07, 0.12, 10);                                                           // reactor
    k(3, [2.6, 0.7, 0.2]); cyl(0, -0.468, -0.46, 0.05, 0.05, 10);
    for (let i = 0; i < 4; i++) { k(6, HD); B(0.1, 0.3, -0.42, -0.3, -0.004, 0.004, 0.4, 1, (i / 4) * TAU + 0.4); k(3, [1.6, 0.35, 0.1]); B(0.12, 0.28, -0.4, -0.32, -0.0045, 0.0045, 0.3, 1, (i / 4) * TAU + 0.4); }
    for (let i = 0; i < 3; i++) {                                                                             // docking arms
      const a = (i / 3) * TAU + 0.52;
      k(6, HM); B(0.1, 0.9, -0.2, -0.176, -0.012, 0.012, 1, 1, a);
      k(0, H2); B(0.86, 0.94, -0.215, -0.16, -0.05, 0.05, 1, 1, a); k(3, [0.3, 1.4, 0.5]); B(0.94, 0.944, -0.2, -0.176, -0.04, 0.04, 1, 1, a);
      k(6, HD); B(0.5, 0.53, -0.2, -0.176, -0.06, 0.06, 1, 1, a);
    }
    { const a = 0.52; k(0, ORG); B(0.6, 0.84, -0.215, -0.165, 0.016, 0.07, 0.6, 0.6, a); k(0, H1); B(0.56, 0.6, -0.22, -0.16, 0.012, 0.074, 1, 1, a); k(2, ENG); B(0.552, 0.56, -0.205, -0.175, 0.025, 0.06, 1, 1, a); }
    k(6, HM); for (let i = 0; i < 12; i++) B(0.29, 0.31, -0.012, 0.012, -0.082, 0.082, 1, 1, (i / 12) * TAU);      // inner truss ring
    for (let i = 0; i < 6; i++) { const a = (i / 6) * TAU + 0.26; k(i & 1 ? 6 : 0, i & 1 ? HM : H1); B(0.1, 0.58, -0.014, 0.014, i & 1 ? -0.012 : -0.022, i & 1 ? 0.012 : 0.022, 1, 1, a); if (!(i & 1)) { k(1, H1); B(0.14, 0.56, 0.014, 0.0148, -0.012, 0.012, 1, 1, a); } }
    const NR = 24, hz = 0.665 * Math.tan(Math.PI / NR) * 1.02;
    for (let i = 0; i < NR; i++) {                                                                            // the habitat ring
      const a = (i / NR) * TAU;
      k(0, i % 6 === 0 ? ORG : i & 1 ? H1 : H2); B(0.575, 0.665, -0.05, 0.05, -hz, hz, 1, 1, a);
      k(1, H1); B(0.57, 0.575, -0.03, 0.03, -hz * 0.86, hz * 0.86, 1, 1, a); B(0.6, 0.64, 0.05, 0.0508, -hz * 0.8, hz * 0.8, 1, 1, a);
      if (i % 3 === 0) { k(3, [0.5, 1.0, 1.8]); B(0.665, 0.668, -0.012, 0.012, -hz * 0.5, hz * 0.5, 1, 1, a); }
      if (i % 6 === 3) { k(0, HM); B(0.665, 0.72, -0.03, 0.03, -hz * 0.7, hz * 0.7, 0.6, 0.6, a); }           // docking ports on the rim
    }
    k(0, H1); cyl(0, -0.24, 0.24, 0.12, 0.12, 10);                                                            // hub
    k(1, H1); cyl(0, -0.07, 0.07, 0.1215, 0.1215, 10); cyl(0, 0.13, 0.17, 0.1215, 0.1215, 10);
    k(0, H2); cyl(0, 0.24, 0.32, 0.12, 0.06, 10); k(6, HM); cyl(0, 0.32, 0.62, 0.02, 0.012, 6);
    k(0, H2); cyl(0, 0.42, 0.44, 0.07, 0.07, 10); k(3, [2.6, 0.4, 0.3]); cyl(0, 0.62, 0.63, 0.016, 0.016, 6);
    for (const sgn of [1, -1]) {                                                                              // solar wings
      k(6, HM); B(sgn * 0.665, sgn * 1.0, 0.1, 0.116, -0.01, 0.01); B(sgn * 0.62, sgn * 0.67, 0.0, 0.116, -0.01, 0.01);
      k(4, H1); B(sgn * 0.72, sgn * 0.985, 0.117, 0.121, 0.022, 0.2); B(sgn * 0.72, sgn * 0.985, 0.117, 0.121, -0.2, -0.022);
    }
    const NS = this.NS = 24;
    const mkKit = (posA, norA, mdlA, colA, n) => {
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(posA), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(norA), 3));
      g.setAttribute('aMdl', new THREE.BufferAttribute(new Float32Array(mdlA), 2));
      g.setAttribute('aCol', new THREE.BufferAttribute(new Float32Array(colA), 3));
      const kit = { n: 0, cap: n, geo: g, mesh: null, P: new Float32Array(n * 4), Q: new Float32Array(n * 4), S: new Float32Array(n * 4), X: new Float32Array(n * 4),
        tP: new Float32Array(n * 4), tQ: new Float32Array(n * 4), tS: new Float32Array(n * 4), tX: new Float32Array(n * 4), key: new Float32Array(n), idx: new Uint16Array(n) };
      g.setAttribute('aIP', dyn(kit.P, 4)); g.setAttribute('aIQ', dyn(kit.Q, 4)); g.setAttribute('aIS', dyn(kit.S, 4)); g.setAttribute('aIX', dyn(kit.X, 4));
      g.instanceCount = 0;
      this._geo(g);
      return kit;
    };
    this.shipU = {
      uNoise: U.uNoise, uCam: U.uCam, uField: U.uField, uEclipse: U.uEclipse, uSunCol: U.uSunCol, uTime: U.uTime,
      uKey: { value: new THREE.Vector3(0, 1, 0) }, uAmb2: { value: new THREE.Color(0.05, 0.06, 0.085) },
      uDR: { value: new THREE.Vector2(100, 20000) }, uOcc: { value: new THREE.Vector4(0, 0, 0, 0) },
    };
    const depth = this.opts.shipDepth;
    const shipMat = this._mat({ uniforms: this.shipU, vs: SHIP_VS, fs: SHIP_FS, blending: THREE.NormalBlending, defines: depth ? { SHIP_DEPTH: 1 } : {} });
    if (depth) { shipMat.depthTest = true; shipMat.depthWrite = true; }   // far-end sliver only, see SHIP_VS
    this._kitShips = mkKit(pos, nor, mdl, colr, NS);
    this._kitShips.mesh = this.shipsMesh = this._mesh(this._kitShips.geo, shipMat, RO.ship);
    // 4, 5: rocks (their own kit: an asteroid belt is 40 instances and should not drag the hulls' triangles along)
    pos.length = nor.length = mdl.length = colr.length = 0; K = 5; C = H1; CE = null;
    for (M = 4; M < 6; M++) {
      const ig = new THREE.IcosahedronGeometry(1, 1), p = ig.attributes.position;
      const jit = (x, y, z) => { const h = Math.sin(x * 12.9898 * M + y * 78.233 + z * 37.719) * 43758.5453; return h - Math.floor(h); };
      const V = (i) => { const x = p.getX(i), y = p.getY(i), z = p.getZ(i), sc = 0.72 + 0.5 * jit(Math.round(x * 50), Math.round(y * 50), Math.round(z * 50)); return [x * sc, y * sc, z * sc]; };
      for (let i = 0; i < p.count; i += 3) tri(V(i), V(i + 1), V(i + 2), C, C, C);
      ig.dispose();
    }
    this._kitRocks = mkKit(pos, nor, mdl, colr, this.lo ? 24 : 44);
    this._kitRocks.mesh = this.rocksMesh = this._mesh(this._kitRocks.geo, shipMat, RO.ship - 1);
    this.shipsMesh.visible = this.rocksMesh.visible = false;
    this._ns = 0;
    this.debugInst = null;   // debug: [model, x, y, z, qx, qy, qz, qw, scale] drawn every frame (harness ?view=ship)
  }

  _buildFog() {
    const THREE = this.THREE, U = this.U, P = this._pal;
    const geo = this._geo(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
    // [y, noise scale, parallax, density, far fade, inner (under-field) factor]
    const L = this.lo
      ? [[-90, 1 / 560, 0.8, 0.9, 5200, 0.5], [-420, 1 / 900, 0.45, 1.0, 7000, 0.75]]
      : [[-60, 1 / 480, 0.9, 0.7, 4800, 0.42], [-220, 1 / 700, 0.62, 0.9, 6000, 0.6], [-520, 1 / 1050, 0.38, 1.0, 8000, 0.8]];
    if (this.opts.fogLayers != null) L.length = Math.max(0, Math.min(L.length, this.opts.fogLayers | 0));
    this.fog = [];
    for (let i = L.length - 1; i >= 0; i--) {
      const l = L[i];
      const u = {
        uNoise: U.uNoise, uCam: U.uCam, uField: U.uField, uTime: U.uTime, uScroll: U.uScroll, uWarp: U.uWarp,
        uIon: U.uIon, uEclipse: U.uEclipse, uLP: U.uLP, uLC: U.uLC, uLN: U.uLN, uFlashP: U.uFlashP, uFlashC: U.uFlashC,
        uSunDir: U.uSunDir, uSunCol: U.uSunCol, uSeed: U.uSeed,
        uFogCol: { value: P.fog }, uFogCol2: { value: P.fog2 },
        uPar: { value: l[2] }, uScale: { value: l[1] }, uDens: { value: l[3] }, uGain: { value: this.opts.lightGain },
        uLayer: { value: i + 1 }, uFar: { value: l[4] }, uInner: { value: l[5] },
      };
      const m = this._mesh(geo, this._mat({ uniforms: u, vs: WORLD_VS, fs: FOG_FS, side: THREE.DoubleSide, premult: true }), RO.fog + (L.length - 1 - i));
      m.position.y = l[0];
      m.scale.set(16000, 1, 11000);
      this.fog.push({ mesh: m, u, dens: l[3] });
    }
  }

  _buildLane() {
    const THREE = this.THREE, U = this.U, P = this._pal;
    this.laneU = {
      uCam: U.uCam, uField: U.uField, uTime: U.uTime, uScroll: U.uScroll, uWarp: U.uWarp, uIon: U.uIon,
      uLP: U.uLP, uLC: U.uLC, uLN: U.uLN, uFlashP: U.uFlashP, uFlashC: U.uFlashC,
      uRail: { value: P.rail }, uGrid: { value: P.grid }, uLane: { value: 0 },
    };
    const geo = this._geo(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
    this.lane = this._mesh(geo, this._mat({ uniforms: this.laneU, vs: WORLD_VS, fs: LANE_FS, side: THREE.DoubleSide }), RO.lane);
    this.lane.position.set(4000, -14, 0);
    this.lane.scale.set(13000, 1, 1600);
  }

  _buildDust() {
    const THREE = this.THREE, U = this.U, P = this._pal;
    const N = this.lo ? 240 : 620;
    const R = makeRng(4242);
    const BX = 5600, BY = 880, BZ = 3800;
    const pos = new Float32Array(N * 3), d = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = R() * BX; pos[i * 3 + 1] = R() * BY; pos[i * 3 + 2] = R() * BZ;
      const near = R();
      d[i * 3] = 0.45 + near * 1.3;            // parallax
      d[i * 3 + 1] = 0.25 + R() * 0.75;        // brightness
      d[i * 3 + 2] = 1.2 + near * 2.2 * R();   // world half-width
    }
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.setAttribute('aPos', new THREE.InstancedBufferAttribute(pos, 3));
    geo.setAttribute('aD', new THREE.InstancedBufferAttribute(d, 3));
    geo.instanceCount = N;
    this.dustU = {
      uCam: U.uCam, uField: U.uField, uPx: U.uPx, uAspect: U.uAspect, uScroll: U.uScroll,
      uBox: { value: new THREE.Vector3(BX, BY, BZ) }, uAnchor: { value: new THREE.Vector3() },
      uDustCol: { value: P.dust }, uLen: { value: 4 }, uBright: { value: 1 },
    };
    this.dust = this._mesh(this._geo(geo), this._mat({ uniforms: this.dustU, vs: DUST_VS, fs: DUST_FS }), RO.dust);
  }

  _buildBolts() {
    const THREE = this.THREE, U = this.U;
    const SEG = this.BOLT_SEG = 150;
    this.bolts = [];
    for (let b = 0; b < (this.lo ? 2 : 3); b++) {
      const aA = new Float32Array(SEG * 4 * 3), aB = new Float32Array(SEG * 4 * 3), aUV = new Float32Array(SEG * 4 * 3);
      const idx = new Uint16Array(SEG * 6);
      for (let s = 0; s < SEG; s++) {
        const v = s * 4;
        idx.set([v, v + 1, v + 2, v, v + 2, v + 3], s * 6);
        aUV.set([0, -1, 1, 1, -1, 1, 1, 1, 1, 0, 1, 1], v * 3);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SEG * 4 * 3), 3));
      geo.setAttribute('aA', new THREE.BufferAttribute(aA, 3));
      geo.setAttribute('aB', new THREE.BufferAttribute(aB, 3));
      geo.setAttribute('aUV', new THREE.BufferAttribute(aUV, 3));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      geo.setDrawRange(0, 0);
      const u = { uPx: U.uPx, uAspect: U.uAspect, uLife: { value: 0 }, uBoltCol: { value: new THREE.Color(5, 7.5, 12) } };
      const mesh = this._mesh(this._geo(geo), this._mat({ uniforms: u, vs: BOLT_VS, fs: BOLT_FS }), RO.bolt);
      mesh.visible = false;
      this.bolts.push({ mesh, geo, u, aA, aB, aUV, age: 0, life: 0, on: false, n: 0, x: 0, y: 0, z: 0 });
    }
  }

  _buildComet() {
    const THREE = this.THREE, U = this.U;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.cometU = {
      uCam: U.uCam, uField: U.uField, uPx: U.uPx, uAspect: U.uAspect,
      uA: { value: new THREE.Vector3() }, uB: { value: new THREE.Vector3() }, uW: { value: 26 },
      uCometCol: { value: new THREE.Color(1.15, 1.0, 0.78) }, uLife: { value: 0 }, uHead: { value: 1 },
    };
    this.comet2U = {
      uCam: U.uCam, uField: U.uField, uPx: U.uPx, uAspect: U.uAspect,
      uA: { value: new THREE.Vector3() }, uB: { value: new THREE.Vector3() }, uW: { value: 16 },
      uCometCol: { value: new THREE.Color(0.35, 0.7, 1.6) }, uLife: { value: 0 }, uHead: { value: 0 },
    };
    this._geo(geo);
    this.cometMesh2 = this._mesh(geo, this._mat({ uniforms: this.comet2U, vs: COMET_VS, fs: COMET_FS }), RO.comet);
    this.cometMesh = this._mesh(geo, this._mat({ uniforms: this.cometU, vs: COMET_VS, fs: COMET_FS }), RO.comet);
    this.cometMesh.visible = this.cometMesh2.visible = false;
    this._comet = { on: false, t: 0, dur: 9, from: new THREE.Vector3(), to: new THREE.Vector3(), impact: null, n: new THREE.Vector3(), off: new THREE.Vector3() };
  }

  /* --------------------------------- sectors --------------------------------- */

  /**
   * New level: re-seed and re-colour everything (crossfades over ~1.5 s).
   * While the environment has not been on screen yet (no update() with time passing) the new
   * sector simply replaces the old one — the menu's first frame is not the tail of a crossfade.
   */
  setSector(level, theme) {
    const th = theme || DEFAULT_THEME;
    const lvl = (level | 0) || 1;
    const seed = (Math.imul(lvl, 2654435761) ^ Math.imul((th.hue | 0) + 17, 40503)) >>> 0;
    this._pending = { seed, theme: th, level: lvl };
    this._derivePalette(this._palTo, seed, th);
    this.sector = { level: lvl, theme: th.name || '', star: this._pending.star, binary: this._pending.binary, planets: this.sector.planets, twin: this.sector.twin };
    if (!this._hasSector || this._seen < 2) {
      this._hasSector = true;
      this._copyPal(this._pal, this._palTo);
      this._applySector();
      this._keyFrom.copy(this._keyTo);
      this.sunDirection.copy(this._keyTo);
      this._fade = 1; this._fadeSwapped = true;
    } else {
      this._copyPal(this._palFrom, this._pal);
      this._keyFrom.copy(this.sunDirection);
      this._fade = 0; this._fadeSwapped = false;
    }
  }

  _copyPal(a, b) {
    for (const k of PAL_COLORS) a[k].copy(b[k]);
    for (const k of PAL_NUMS) a[k] = b[k];
  }

  _lerpPal(out, a, b, t) {
    for (const k of PAL_COLORS) out[k].copy(a[k]).lerp(b[k], t);
    for (const k of PAL_NUMS) out[k] = a[k] + (b[k] - a[k]) * t;
  }

  // everything that is derived from a SECTOR_THEMES entry (+ the level seed)
  _derivePalette(p, seed, th) {
    const THREE = this.THREE, SR = THREE.SRGBColorSpace;
    const R = makeRng(seed);
    const bias = THEME_BIAS[th.name] || THEME_BIAS[Object.keys(THEME_BIAS)[seed % 8]];
    const hue = (((th.hue ?? 220) + (R() - 0.5) * (th.hueJit ?? 30)) % 360 + 360) % 360;
    const sat = clamp01((th.sat ?? 42) / 100);
    const H = (h) => (((h % 360) + 360) % 360) / 360;
    const smA = th.smudgeA ?? 1, smN = th.smudge ?? 5;
    const off = [38, -46, 150, -28, 62][(R() * 5) | 0];
    p.base.setHSL(H(hue), sat * 0.75, 0.05, SR).multiplyScalar(0.55);
    p.nebA.setHSL(H(hue), Math.min(0.95, sat + 0.34), 0.5, SR).multiplyScalar(0.22);
    p.nebB.setHSL(H(hue + off), Math.min(0.9, sat + 0.3), 0.5, SR).multiplyScalar(0.2);
    p.nebC.setHSL(H(hue + off * 0.5 + 20), 0.55, 0.72, SR).multiplyScalar(0.3);
    p.gal.setHSL(H(hue + 30), 0.2, 0.7, SR).multiplyScalar(0.05 + 0.03 * (th.starBright ?? 1));
    p.fog.setHSL(H(hue - 8), Math.min(0.85, sat + 0.2), 0.52, SR).multiplyScalar(0.075);
    p.fog2.setHSL(H(hue + off * 0.6), Math.min(0.85, sat + 0.25), 0.5, SR).multiplyScalar(0.07);
    p.rail.setHSL(H(hue), Math.min(0.8, sat + 0.3), 0.62, SR).multiplyScalar(0.62);
    p.grid.setHSL(H(hue), Math.min(0.7, sat + 0.15), 0.66, SR).multiplyScalar(0.3);
    p.dust.setHSL(H(hue), 0.25, 0.8, SR).multiplyScalar(0.55);
    p.nebAmt = 0.55 + 0.35 * smA + 0.03 * smN;
    p.fogDens = 0.55 + 0.3 * smA;
    p.starBright = 0.8 * (th.starBright ?? 1);

    const sName = bias.stars[(R() * bias.stars.length) | 0];
    const sc = STAR_CLASS[sName];
    const binary = R() < bias.binary;
    p.sunCol.setRGB(sc.col[0], sc.col[1], sc.col[2]);
    p.keyCol.setRGB(sc.key[0], sc.key[1], sc.key[2]);
    p.sunR = sc.r * (0.9 + R() * 0.25); p.sunI = sc.i;
    const comp = STAR_CLASS[sName === 'blue' ? 'orange' : sName === 'red' ? 'white' : 'blue'];
    p.sun2Col.setRGB(comp.col[0], comp.col[1], comp.col[2]);
    p.sun2R = comp.r * 0.42; p.sun2I = binary ? 0.75 : 0;
    p.haze.copy(p.sunCol).multiplyScalar(0.022).add(this._c.copy(p.nebA).multiplyScalar(0.22));
    p.ambCol.setHSL(H(hue), 0.5, 0.68, SR).lerp(this._c.setRGB(0.27, 0.48, 1), 0.45);

    // geometry-ish (hard-swapped at the midpoint of the crossfade)
    const n = this._pending;
    n.hue = hue; n.star = sName; n.binary = binary; n.bias = bias;
    const side = R() < 0.5 ? -1 : 1;
    n.sunAz = side * (0.2 + R() * 0.26);          // rad off +X: inside the chase frame
    n.sunEl = -(0.03 + R() * 0.045);              // just under the lane's vanishing line
    n.seedV = [R() * 23, R() * 23, R() * 23];
    n.rot = [R() * 6.283, (R() - 0.5) * 2.2, R() * 6.283];
    n.starCount = clamp01((th.stars ?? 700) / 920);
    n.planetSeed = (seed ^ 0x9e3779b9) >>> 0;
    n.types = this.opts.planetTypes; n.special = this.opts.special; n.specialSlot = this.opts.specialSlot;
    // key light: the sun's azimuth, lifted so hulls are lit from above in every camera
    const el = this.opts.keyElevation;
    this._keyTo.set(Math.cos(n.sunAz) * Math.cos(el), Math.sin(el), Math.sin(n.sunAz) * Math.cos(el)).normalize();
  }

  // hard swap: noise seeds, star shell, sun position, planets
  _applySector() {
    const n = this._pending, U = this.U, THREE = this.THREE;
    if (!n) return;
    U.uSeed.value.set(n.seedV[0], n.seedV[1], n.seedV[2]);
    const ce = Math.cos(n.sunEl);
    const sd = this.sunSkyDirection.set(Math.cos(n.sunAz) * ce, Math.sin(n.sunEl), Math.sin(n.sunAz) * ce).normalize();
    U.uSunDir.value.copy(sd);
    U.uSunT.value.set(0, 1, 0).cross(sd).normalize();
    U.uSunB.value.copy(sd).cross(U.uSunT.value).normalize();
    U.uSun2Dir.value.copy(sd).addScaledVector(U.uSunT.value, 0.11).addScaledVector(U.uSunB.value, 0.035).normalize();
    this._m4.makeRotationFromEuler(this._e.set(n.rot[1], n.rot[0], n.rot[2]));
    this.starU.uRot.value.setFromMatrix4(this._m4);
    this.skyU.uGalN.value.set(0, 1, 0).applyMatrix4(this._m4).normalize();
    this.starU.uCount.value = n.starCount;
    this._seedPlanets(n);
  }

  _seedPlanets(n) {
    if (!this.planets.length) return;
    const R = makeRng(n.planetSeed);
    const hw = this._W / 2, hh = this._H / 2;
    const sunSide = Math.sign(n.sunAz) || 1;
    const V = this._v, V2 = this._v2, Q = this._q;
    // the sun as a place, not just a direction: every body is lit from where it actually
    // is relative to it — worlds beyond the sun show a full face, nearer ones a crescent
    this._sunPos.copy(this.sunSkyDirection).multiplyScalar(5200); this._sunPos.y += 260;
    this._stopEvents();
    this._bk.cur = -1;
    for (const s of this.surfaces) { s.pending = false; s.ready = false; s.live = false; }
    this._stn.on = false; this.shipU.uOcc.value.w = 0;
    const pool = n.bias.planets;
    const types = [pool[(R() * pool.length) | 0], pool[(R() * pool.length) | 0], pool[(R() * pool.length) | 0]];
    if (types[1] === types[0]) types[1] = pool[(R() * pool.length) | 0];
    const count = R() < 0.3 ? 2 : 3;
    // rare specials
    const sp = R(), spSlot = R() < 0.5 ? 0 : 1;
    let twin = -1;
    if (n.special === 'twin' || (!n.special && sp < 0.11)) twin = n.special ? n.specialSlot : spSlot;
    else if (n.special === 'shatter' || (!n.special && sp < 0.19)) types[n.special ? n.specialSlot : spSlot] = 'shatter';
    else if (n.special === 'hotjup' || (!n.special && sp < 0.31)) types[n.special ? n.specialSlot : (types[0] === 'gas' ? 0 : 1)] = 'hotjup';
    if (n.types) for (let i = 0; i < 3; i++) if (n.types[i]) types[i] = n.types[i];
    this.sector.planets = types.slice(0, count); this.sector.twin = twin;
    const amb = this._c2.copy(this._palTo.nebA).multiplyScalar(0.04).addScalar(0.003);
    // the moon pool: one cratered, one icy / sulphurous
    this._dress(null, 4, 'rock', n.hue + R() * 360, R);
    this._dress(null, 5, R() < 0.6 ? 'ice' : 'rock', n.hue + R() * 360, R);
    for (let i = 0; i < this.planets.length; i++) {
      const p = this.planets[i], b = p.body, u = b.u;
      p.on = i < 2 || count === 3;   // slot 0 (TOP backdrop) and slot 1 (the horizon planet) always exist
      p.op = 0; p.imp = -1; u.uImp.value.w = -1; p.aurBoost = 0;
      b.mesh.visible = p.on;
      if (!p.on) { p.halo.visible = p.ring.visible = false; for (const m of p.moons) { m.on = false; m.body.mesh.visible = false; } continue; }
      const tn = types[i], T = PT[tn];
      p.type = tn;
      this._dress(b, i, tn, n.hue + [150, -50, 35, 180, -90][(R() * 5) | 0], R);
      u.uAmb.value.copy(amb);
      const big = tn === 'gas' || tn === 'hotjup';
      if (i === 0) {        // TOP / TILT backdrop: right under the field
        p.R = (big ? 640 : 500) + R() * 420;
        p.pos.set(-hw * 0.25 + R() * hw * 1.1, -(1500 + R() * 1100), -hh * 1.0 + R() * hh * 1.3);
        p.gain = 0.92; u.uRot.value.w = 4.2; u.uP4.value.z = 0.6; u.uP4.value.w = 0.7;   // under the field: calm in the middle, more itself toward the rim
      } else if (i === 1) { // CHASE / menu: rising over the horizon, beyond the sun → fully lit
        p.R = (big ? 1000 : 780) + R() * 650;
        const dist = 9800 + R() * 3200, az = -sunSide * (0.2 + R() * 0.2 + (p.R / dist) * 0.55);
        p.pos.set(Math.cos(az) * dist, -(p.R * (0.3 + R() * 0.6) + 300), Math.sin(az) * dist);
        p.gain = 0.7; u.uRot.value.w = 5;
      } else {              // mid-distance, off to the side
        p.R = 260 + R() * 320;
        p.pos.set(1800 + R() * 2600, -(1300 + R() * 1300), (R() < 0.6 ? -1 : 1) * (1200 + R() * 1700));
        p.gain = 0.55; u.uRot.value.w = 4; u.uP4.value.z = 0.4;
      }
      u.uGain.value = p.gain * T.gain;
      p.drift = 16 * 850 / (850 - p.pos.y + Math.max(0, p.pos.x) * 0.5);
      p.spin = R() * 6.28; p.spinV = (big ? 0.02 : 0.011) * (0.6 + R() * 0.8);
      // axis: tipped toward the viewer so bands, caps and rings read in both cameras
      const tip = i === 0 ? 0.6 + R() * 0.5 : 0.3 + R() * 0.55;
      p.qTilt.setFromAxisAngle(V.set(0, 0, 1), (R() < 0.5 ? -1 : 1) * tip);
      Q.setFromAxisAngle(V.set(1, 0, 0), (R() - 0.5) * 0.9); p.qTilt.premultiply(Q);
      p.axis.set(0, 1, 0).applyQuaternion(p.qTilt);
      u.uRingN.value.copy(p.axis);
      p.hasHalo = T.halo > 0;
      p.halo.visible = p.hasHalo;
      if (p.hasHalo) { p.haloS = T.halo; p.hu.uLimb.value = Math.sqrt(1 - 1 / (T.halo * T.halo)); p.hu.uGain.value = p.gain * 1.5; }
      p.aur = T.aur * (R() < 0.6 ? 0.5 + R() * 0.6 : 0);
      const rr = R() < T.ring;
      p.hasRing = (this.opts.rings ?? rr) && twin !== i;
      p.ring.visible = p.hasRing;
      u.uRingP.value.set(1, 2, 0, 0);
      if (p.hasRing) {
        const deb = tn === 'shatter';
        p.ringIn = deb ? 1.15 + R() * 0.1 : 1.25 + R() * 0.3; p.ringOut = p.ringIn + (deb ? 0.9 : 0.55) + R() * 0.75;
        const row = ((deb ? 7 : (R() * 7) | 0) + 0.5) / 8;
        p.ru.uR0.value = p.ringIn / p.ringOut * 2; p.ru.uR1.value = 2; // RingGeometry spans radius 1..2
        p.ru.uRingCol.value.copy(b.surf.job.c[0]).lerp(this._c.setRGB(0.82, 0.76, 0.68), deb ? 0.3 : 0.6).multiplyScalar(deb ? 0.6 : 1);
        p.ru.uGain.value = p.gain * 1.25;
        p.ru.uSeedP.value.set(R() * 19, R() * 19, R() * 19);
        p.ru.uRingQ.value.set(row, deb ? 1 : 0, this.lo ? 0 : 1, 0);
        u.uRingP.value.set(p.ringIn, p.ringOut, deb ? 0.45 : 0.85, row);
        p.ring.quaternion.copy(p.qTilt).multiply(Q.setFromAxisAngle(V.set(1, 0, 0), -Math.PI / 2));
      }
      // moons: orbits that contain the sun line, so every lap has a transit and an eclipse
      const L = V2.copy(this._sunPos).sub(p.pos).normalize();
      for (let k = 0; k < p.moons.length; k++) {
        const m = p.moons[k], isTwin = twin === i && k === 0;
        m.on = isTwin || R() < (k === 0 ? 0.8 : 0.5);
        m.twin = isTwin;
        m.body.mesh.visible = m.on;
        if (!m.on) continue;
        if (isTwin) {
          let tt = pool[(R() * pool.length) | 0]; if (tt === tn) tt = tn === 'ocean' ? 'desert' : 'ocean';
          this._dress(m.body, 3, tt, n.hue + R() * 360, R);
          m.R = p.R * (0.5 + R() * 0.25); m.D = p.R + m.R + p.R * (0.55 + R() * 0.5); m.v = 0.022 + R() * 0.012;
        } else {
          const si = 4 + ((k + i) & 1), ms = this.surfaces[si];
          this._dressFrom(m.body, ms, si === 4 ? 'rock' : ms.job.type === 2 ? 'ice' : 'rock');
          m.R = p.R * (0.055 + R() * 0.1);
          m.D = p.R * (1.9 + k * 0.9 + R() * 0.8) + (p.hasRing ? p.R * (p.ringOut - 1.2) : 0);
          m.v = (0.038 + R() * 0.04) / (1 + k * 0.6);
        }
        m.body.u.uAmb.value.copy(amb);
        m.gain = p.gain * m.body.T.gain;
        m.a = R() * 6.28; m.spin = R() * 6.28;
        m.e1.copy(L);
        m.e2.set(R() - 0.5, (R() - 0.5) * 0.6 + (i === 0 ? 0 : 0.5), R() - 0.5);
        m.e2.addScaledVector(L, -m.e2.dot(L)).normalize();
        m.e1.addScaledVector(m.e2, (R() - 0.5) * 0.25).normalize();
      }
    }
    // some sectors have an orbital station: it is simply there (and gone with the sector), it never pops in
    const stRoll = R(), stSlot = (R() < 0.8) === (this._view === 2) ? 1 : 0;   // mostly at the planet this camera looks at
    if (this.opts.station ?? stRoll < 0.42) this._placeStation(this.planets[stSlot], false);
  }

  // Point a body at a surface and queue that surface's bake (b = null: surface only).
  _dress(b, si, tn, ph, R) {
    const THREE = this.THREE, SR = THREE.SRGBColorSpace;
    const T = PT[tn], s = this.surfaces[si], j = s.job, c = j.c;
    const H = (h) => (((h % 360) + 360) % 360) / 360;
    const hsl = (col, h, sa, l) => col.setHSL(H(h), sa, l, SR);
    j.type = T.b; j.name = tn;
    j.seed.set(R() * 40, R() * 40, R() * 40);
    j.pr2.set(T.bk, 0, 0, 0);
    const atm = j.atm || (j.atm = new THREE.Color()), sunset = j.sunset || (j.sunset = new THREE.Color()),
      em = j.em || (j.em = new THREE.Color()), cloud = j.cloud || (j.cloud = new THREE.Color()), aur = j.aur || (j.aur = new THREE.Color());
    sunset.setRGB(1, 0.5, 0.24); em.setRGB(0, 0, 0); cloud.setRGB(0.9, 0.9, 0.92); aur.setRGB(0.2, 1.3, 0.55);
    j.emGain = T.em;
    const v = R();
    if (tn === 'gas') {
      const h = v < 0.3 ? 28 + R() * 14 : v < 0.5 ? 205 + R() * 25 : v < 0.65 ? 170 + R() * 20 : ph;   // jovian, neptunian, teal, sector-tinted
      const cool = h > 150 && h < 260;
      hsl(c[0], h, cool ? 0.4 : 0.42, 0.62); hsl(c[1], h + (cool ? 14 : -12), 0.5, cool ? 0.26 : 0.2); hsl(c[2], h + (cool ? -30 : 14), 0.35, 0.78); hsl(c[3], cool ? h + 150 : h - 18, 0.7, 0.42);
      hsl(atm, h - 8, 0.55, 0.62).multiplyScalar(0.5); cloud.copy(c[2]).lerp(this._c.setRGB(1, 1, 1), 0.4);
      j.pr.set(5 + R() * 6, (R() - 0.5) * 0.7, 0.2 + R() * 0.4, 0.6 + R() * 0.6);
      if (R() < 0.5) aur.setRGB(0.9, 0.3, 1.3);
    } else if (tn === 'hotjup') {
      hsl(c[0], 22, 0.75, 0.36); hsl(c[1], 350, 0.6, 0.07); hsl(c[2], 34, 0.9, 0.52); hsl(c[3], 46, 1, 0.66);
      atm.setRGB(1, 0.42, 0.16).multiplyScalar(0.5); em.setRGB(2.4, 0.5, 0.08); cloud.setRGB(0.5, 0.2, 0.1);
      j.pr.set(6 + R() * 5, (R() - 0.5) * 0.6, 0.25 + R() * 0.3, 0.8 + R() * 0.6); j.pr2.z = 1;
    } else if (tn === 'rock') {
      if (v < 0.5) { hsl(c[0], ph, 0.07, 0.5); hsl(c[1], ph + 20, 0.1, 0.27); hsl(c[2], ph, 0.08, 0.12); hsl(c[3], ph, 0.05, 0.64); }             // lunar grey
      else if (v < 0.8) { hsl(c[0], 24, 0.3, 0.42); hsl(c[1], 16, 0.35, 0.22); hsl(c[2], 12, 0.2, 0.1); hsl(c[3], 34, 0.25, 0.58); }               // rusty
      else { hsl(c[0], 50, 0.7, 0.52); hsl(c[1], 30, 0.7, 0.34); hsl(c[2], 14, 0.6, 0.16); hsl(c[3], 58, 0.6, 0.72); }                              // sulphur
      atm.setRGB(0, 0, 0);
      j.pr.set(0, (R() - 0.5) * 0.25, 0.35 + R() * 0.45, R() < 0.5 ? 1 : 0);
    } else if (tn === 'ice') {
      hsl(c[0], 198 + R() * 20, 0.25, 0.86); hsl(c[1], 212, 0.42, 0.66);
      if (v < 0.55) hsl(c[2], 16 + R() * 12, 0.5, 0.3); else hsl(c[2], 215, 0.65, 0.28);
      hsl(c[3], v < 0.55 ? 28 : 200, 0.22, 0.6);
      atm.setRGB(0.4, 0.65, 1).multiplyScalar(0.35); sunset.setRGB(0.9, 0.6, 0.5);
      j.pr.set(1.5 + R() * 1.6, 0, 0.1 + R() * 0.2, 0);
    } else if (tn === 'lava') {
      hsl(c[0], 18 + R() * 14, 0.14, 0.24); hsl(c[1], 250, 0.08, 0.075); hsl(c[2], 8, 0.85, 0.2); hsl(c[3], 32, 0.14, 0.36);   // basalt, dark basalt, melt in daylight, ash
      atm.setRGB(1, 0.36, 0.14).multiplyScalar(0.3); sunset.setRGB(1, 0.3, 0.1); em.setRGB(2.8, 0.62, 0.08); cloud.setRGB(0.2, 0.175, 0.16);
      j.pr.set(1.7 + R() * 1.1, -0.1 + R() * 0.16, 0.22 + R() * 0.2, 0);   // plate frequency, activity bias, volcano density
    } else if (tn === 'ocean') {
      const alien = v > 0.78;
      hsl(c[0], (alien ? 180 : 212) + R() * 16, 0.68, 0.2);
      if (alien) hsl(c[1], 285 + R() * 50, 0.35, 0.24); else hsl(c[1], 95 + R() * 45, 0.42, 0.2);
      hsl(c[2], 34 + R() * 10, 0.4, 0.5); c[3].setRGB(0.3, 0.3, 0.3);
      atm.setRGB(0.3, 0.56, 1).multiplyScalar(0.62); sunset.setRGB(1, 0.42, 0.18); em.setRGB(2.1, 1.35, 0.6);
      j.pr.set(1.15 + R() * 0.7, -0.1 + R() * 0.15, -0.17 + R() * 0.14, 0.72 + R() * 0.18);
      j.pr2.y = R() < 0.7 ? 0.6 + R() * 0.5 : 0; // inhabited?
    } else if (tn === 'desert') {
      const h = v < 0.5 ? 18 + R() * 10 : v < 0.8 ? 36 + R() * 8 : ph;
      hsl(c[0], h, 0.5, 0.46); hsl(c[1], h + 6, 0.48, 0.3); hsl(c[2], h - 8, 0.25, 0.13); hsl(c[3], h + 12, 0.3, 0.58);
      hsl(atm, h + 14, 0.5, 0.6).multiplyScalar(0.3); sunset.setRGB(0.45, 0.6, 1); em.setRGB(2.1, 1.35, 0.6); cloud.copy(c[3]).lerp(this._c.setRGB(1, 1, 1), 0.35);
      j.pr.set(1.2 + R() * 0.8, R() < 0.7 ? 1 : 0, 0.15 + R() * 0.25, 0.8 + R() * 0.12);
      j.pr2.y = R() < 0.35 ? 0.7 : 0; j.pr2.w = -0.08 + R() * 0.1;
    } else { // shattered world
      hsl(c[0], ph, 0.1, 0.36); hsl(c[1], ph + 20, 0.12, 0.2); hsl(c[2], 8, 0.5, 0.1); hsl(c[3], ph, 0.05, 0.5);
      atm.setRGB(0, 0, 0); em.setRGB(3, 0.8, 0.12);
      j.pr.set(0, 0, 0.3 + R() * 0.3, 0);
    }
    if (j.pr2.y === 0 && T.mode === 0) j.emGain = 0;
    s.pending = true; s.ready = false; s.live = true;
    if (b) this._dressFrom(b, s, tn, R);
  }

  _dressFrom(b, s, tn, R) {
    const T = PT[tn], u = b.u, j = s.job, lo = this.lo;
    this._surfRT(s);
    b.T = T; b.type = tn; b.surf = s;
    u.uMapA.value = s.A.texture; u.uMapB.value = s.B.texture;
    u.uAtm.value.copy(j.atm); u.uSunset.value.copy(j.sunset); u.uEmCol.value.copy(j.em); u.uCloudCol.value.copy(j.cloud); u.uAurCol.value.copy(j.aur);
    const r1 = R ? R() : 0.5, r2 = R ? R() : 0.5, r3 = R ? R() : 0.5;
    u.uP.value.set(T.cloud, T.spec, T.bump, lo ? 0 : T.flow);
    u.uP2.value.set(j.emGain, T.ltn, 0, T.det);
    u.uP3.value.set(T.term, r1, 5 + r2 * 6, r3 * 6.28);
    u.uP4.value.set(T.da, T.rim, 0, 0.15);
    u.uRot.value.set(r1 * 6.28, T.mode, T.haze, 6);
    u.uRingP.value.set(1, 2, 0, 0);
    u.uMoonS.value[0].w = 0; u.uMoonS.value[1].w = 0;
    u.uImp.value.w = -1;
    b.cloudA = r1 * 6.28; b.cloudV = (0.004 + r2 * 0.006) * (r3 < 0.5 ? -1 : 1); b.flowT = r1; b.flowV = 0.011 + r2 * 0.008;
  }

  /* --------------------------------- weather --------------------------------- */

  /** Fire one lightning bolt + flash near (x, z) on the play plane. */
  lightning(x = 0, z = 0) {
    const R = this._rand;
    // runs through the mist under the lane: visible as a forked line in every camera
    const a = R() * 6.283, len = 620 + R() * 620;
    const ax = Math.cos(a), az = Math.sin(a) * 0.75;
    const x0 = x - ax * len * 0.55, z0 = z - az * len * 0.55, y0 = -150 - R() * 220;
    const x1 = x + ax * len * 0.45, z1 = z + az * len * 0.45, y1 = -50 - R() * 60;
    const b = this._bolt(x0, y0, z0, x1, y1, z1, 46, 9, 30, 0.24 + R() * 0.16);
    b.u.uBoltCol.value.setRGB(5, 7.5, 12);
    b.sky = false;
    this._flash = 1;
    this.U.uFlashP.value.set(b.x, b.y, b.z, 1200);
  }

  // one forked bolt between two world points (jit = sideways wander, w = core width, drop = how far forks sag)
  _bolt(x0, y0, z0, x1, y1, z1, jit, w, drop, life) {
    let b = null;
    for (const c of this.bolts) if (!c.on) { b = c; break; }
    if (!b) { b = this.bolts[0]; for (const c of this.bolts) if (c.age / c.life > b.age / b.life) b = c; }
    const R = this._rand, SEG = this.BOLT_SEG;
    let n = 0;
    const seg = (ax0, ay0, az0, bx0, by0, bz0, wd) => {
      if (n >= SEG) return;
      for (let k = 0; k < 4; k++) {
        const o = (n * 4 + k) * 3;
        b.aA[o] = ax0; b.aA[o + 1] = ay0; b.aA[o + 2] = az0;
        b.aB[o] = bx0; b.aB[o + 1] = by0; b.aB[o + 2] = bz0;
        b.aUV[o + 2] = wd;
      }
      n++;
    };
    const strand = (sx, sy, sz, ex, ey, ez, steps, jt, wd, depth) => {
      let px = sx, py = sy, pz = sz, ox = 0, oy = 0, oz = 0;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps, env = Math.sin(Math.PI * Math.min(t, 0.97));
        ox = ox * 0.72 + (R() - 0.5) * jt; oy = oy * 0.72 + (R() - 0.5) * jt * 0.45; oz = oz * 0.72 + (R() - 0.5) * jt;
        const qx = sx + (ex - sx) * t + ox * env, qy = sy + (ey - sy) * t + oy * env, qz = sz + (ez - sz) * t + oz * env;
        seg(px, py, pz, qx, qy, qz, wd * (1 - 0.45 * t));
        if (depth > 0 && R() < 0.16 && i < steps - 2) {
          const fl = (1 - t) * 0.55 + 0.15, fa = (R() - 0.5) * 1.7;
          const dx = ex - sx, dz = ez - sz, cs = Math.cos(fa), sn = Math.sin(fa);
          strand(qx, qy, qz, qx + (dx * cs - dz * sn) * fl, qy - drop - R() * drop * 3, qz + (dx * sn + dz * cs) * fl,
            Math.max(5, (steps * fl * 0.7) | 0), jt * 0.8, wd * 0.5, depth - 1);
        }
        px = qx; py = qy; pz = qz;
      }
    };
    strand(x0, y0, z0, x1, y1, z1, 34, jit, w, 2);
    b.n = n;
    b.geo.attributes.aA.needsUpdate = b.geo.attributes.aB.needsUpdate = b.geo.attributes.aUV.needsUpdate = true;
    b.geo.setDrawRange(0, n * 6);
    b.on = true; b.age = 0; b.life = life;
    b.x = (x0 + x1) / 2; b.y = (y0 + y1) / 2; b.z = (z0 + z1) / 2;
    b.mesh.visible = true;
    return b;
  }

  /** Ambient event: a comet crossing far below / beyond the field. */
  comet() {
    const c = this._comet, R = this._rand;
    const s = R() < 0.5 ? -1 : 1;
    c.from.set(5200 + R() * 2500, -500 - R() * 500, s * (1800 + R() * 2200));
    c.to.set(-2600 - R() * 1200, -1200 - R() * 600, -s * (300 + R() * 1500));
    c.t = 0; c.dur = 8 + R() * 4; c.on = true; c.impact = null;
    this.cometMesh.visible = this.cometMesh2.visible = true;
    return true;
  }

  /* ------------------------------ ambient events ----------------------------- */
  //
  // Rare, far-away life: each event draws itself every frame into two immediate
  // buffers (blips = lights, instances = hulls / rocks), or drives a few sky /
  // planet uniforms. Bright small things only ever live where the view does not
  // pass through the play field (the blip shader enforces it per sprite).

  _blip(x, y, z, tx, ty, tz, r, g, b, size, shape, sky) {
    const i = this._nb; if (i >= this.NB) return;
    const o = i * 4, P = this._bP, Q = this._bQ, K = this._bK, k = this._evGain * this._dipK;
    P[o] = x; P[o + 1] = y; P[o + 2] = z; P[o + 3] = sky ? 1 : 0;
    Q[o] = tx; Q[o + 1] = ty; Q[o + 2] = tz; Q[o + 3] = shape;
    K[o] = r * k; K[o + 1] = g * k; K[o + 2] = b * k; K[o + 3] = size;
    this._nb = i + 1;
  }

  _inst(model, x, y, z, qx, qy, qz, qw, sx, sy, sz, op, seed, glow, tint = 0, flag = 0) {
    const kit = model === 4 || model === 5 ? this._kitRocks : this._kitShips;
    const i = kit.n; if (i >= kit.cap || op <= 0) return;
    const o = i * 4, P = kit.tP, Q = kit.tQ, S = kit.tS, X = kit.tX, c = this.U.uCam.value, f = this._fwd;
    P[o] = x; P[o + 1] = y; P[o + 2] = z; P[o + 3] = model;
    Q[o] = qx; Q[o + 1] = qy; Q[o + 2] = qz; Q[o + 3] = qw;
    S[o] = sx; S[o + 1] = sy; S[o + 2] = sz; S[o + 3] = op * this._evGain * this._dipK;
    X[o] = seed; X[o + 1] = glow; X[o + 2] = tint; X[o + 3] = flag;
    const d = (x - c.x) * f.x + (y - c.y) * f.y + (z - c.z) * f.z, r = Math.max(sx, sy, sz) * (model === 3 ? 1.05 : model >= 4 && model < 6 ? 1.25 : 0.72);
    kit.key[i] = d;
    if (d - r < this._dNear) this._dNear = d - r;
    if (d + r > this._dFar) this._dFar = d + r;
    kit.n = i + 1;
  }

  // back-to-front into the instance buffers (insertion sort over ≤ 44 keys, no allocations)
  _flushKit(kit) {
    const n = kit.n, idx = kit.idx, key = kit.key, g = kit.geo;
    for (let i = 0; i < n; i++) idx[i] = i;
    for (let i = 1; i < n; i++) { const v = idx[i], kv = key[v]; let j = i - 1; while (j >= 0 && key[idx[j]] < kv) { idx[j + 1] = idx[j]; j--; } idx[j + 1] = v; }
    for (let i = 0; i < n; i++) {
      const a = idx[i] * 4, o = i * 4;
      for (let c = 0; c < 4; c++) { kit.P[o + c] = kit.tP[a + c]; kit.Q[o + c] = kit.tQ[a + c]; kit.S[o + c] = kit.tS[a + c]; kit.X[o + c] = kit.tX[a + c]; }
    }
    g.instanceCount = n; kit.mesh.visible = n > 0;
    if (n > 0) g.attributes.aIP.needsUpdate = g.attributes.aIQ.needsUpdate = g.attributes.aIS.needsUpdate = g.attributes.aIX.needsUpdate = true;
  }

  // CPU twin of the shaders' fieldMask(): how much of this view ray crosses the play field
  _maskAt(dx, dy, dz) {
    const c = this.U.uCam.value;
    if (dy > -1e-4 || c.y <= 0) return 0;
    const t = c.y / -dy, hx = c.x + dx * t, hz = c.z + dz * t, hw = this._W / 2, hh = this._H / 2;
    const a = clamp01((Math.max(-hw - 120 - hx, hx - hw - 420) + 220) / 440), b = clamp01((Math.abs(hz) - hh + 130) / 260);
    return (1 - smooth(a)) * (1 - smooth(b));
  }

  _viewDir(out, nx, ny) { return out.set(nx, ny, 0.5).unproject(this._cam).sub(this.U.uCam.value).normalize(); }

  // a random on-screen direction that does NOT look through the play field
  _skySpot(out) {
    if (!this._cam) return false;
    const R = this._rand;
    for (let i = 0; i < 18; i++) {
      this._viewDir(out, (R() * 2 - 1) * 0.88, -0.6 + R() * 1.5);
      if (this._maskAt(out.x, out.y, out.z) < 0.06) return true;
    }
    return false;
  }

  // a far world position for an event: along a free view direction, else deep under the field
  _place(out, dMin, dMax) {
    const R = this._rand;
    if (this._skySpot(out)) { out.multiplyScalar(dMin + R() * (dMax - dMin)).add(this.U.uCam.value); return true; }
    out.set((R() - 0.3) * this._W * 0.7, -(1500 + R() * 800), (R() - 0.5) * this._H * 0.8);
    return false;
  }

  _pickPlanet(pref, needHalo) {
    for (const i of pref) { const p = this.planets[i]; if (p && p.on && p.op > 0.6 && (!needHalo || p.hasHalo)) return p; }
    return null;
  }

  _buildEvents() {
    const THREE = this.THREE, R = () => this._rand();
    const V3 = () => new THREE.Vector3();
    const ev = this._events = {};
    const def = (name, o) => { o.name = name; o.on = false; o.t = 0; ev[name] = o; };
    const envl = (t, dur, a, b) => clamp01(Math.min(t / a, (dur - t) / b));
    const cam = this.U.uCam.value;
    const A = V3(), B = V3(), C = V3(), D = V3();
    const yaw = (vx, vz) => Math.atan2(-vz, vx) * 0.5;
    const self = this;
    this._evGain = 1; this._dipK = 1; this._evBig = null; this._evTimer = 5 + R() * 6; this._minorT = 4 + R() * 6; this._view = 2;

    /* --- comets --- */
    def('comet', { big: true, w: [1, 1, 1], start: () => { this.comet(); return true; }, tick: () => this._comet.on });
    const ej = this._ej = { on: false, t: 0, p: null, n: V3(), d: new Float32Array(30), s: new Float32Array(10) };
    def('cometImpact', {
      big: true, loud: true, w: [1, 0.8, 0.9],
      start: (o) => {
        const p = o.planet != null ? this._pickPlanet([o.planet]) : this._pickPlanet(this._view === 2 ? [1, 2, 0] : [0, 2, 1]);
        if (!p) return false;
        const c = this._comet;
        const toCam = A.copy(cam).sub(p.pos).normalize();
        c.n.set(R() - 0.5, R() - 0.5, R() - 0.5).multiplyScalar(0.8).addScaledVector(toCam, 0.8).addScaledVector(p.sun, 0.1).normalize();
        B.set(R() - 0.5, R() * 0.6 + 0.1, R() - 0.5); B.addScaledVector(toCam, -B.dot(toCam)).normalize();
        c.off.copy(c.n).addScaledVector(B, 1.6).normalize().multiplyScalar(p.R * 4 + 2600);
        c.impact = p; c.t = 0; c.dur = 4.6; c.on = true;
        this.cometMesh.visible = this.cometMesh2.visible = true;
        return true;
      },
      tick: () => this._comet.on || ej.on,
    });

    /* --- meteors: fast bright streaks with a train that hangs in the sky for a moment; now and
           then a slow fireball that flares, breaks up and ends in a flash --- */
    const MN = 14, MS = 12, md = new Float32Array(MN * MS); let mCount = 0;
    const MCOL = [[0.55, 1.5, 0.95], [1.6, 0.85, 0.3], [0.7, 0.95, 1.7], [1.4, 1.3, 1.0]];
    def('meteors', {
      w: [0, 0.4, 1],
      start: (o) => {
        if (!this._skySpot(A)) return false;
        B.set(R() - 0.5, -R() * 0.6, R() - 0.5); B.addScaledVector(A, -B.dot(A)).normalize();
        mCount = Math.min(MN, o.count || 7 + ((R() * 7) | 0));
        const span = mCount > 2 ? 5.5 : 0.6;
        let last = 0;
        for (let i = 0; i < mCount; i++) {
          const k = i * MS, fire = o.fireball || (mCount <= 2 ? R() < 0.22 : i === 0 && R() < 0.5) ? 1 : 0;
          C.set(R() - 0.5, R() - 0.5, R() - 0.5).multiplyScalar(mCount > 2 ? 0.55 : 0.12).add(A).normalize();
          D.set(R() - 0.5, R() - 0.5, R() - 0.5).multiplyScalar(0.3).add(B); D.addScaledVector(C, -D.dot(C)).normalize();
          md[k] = C.x; md[k + 1] = C.y; md[k + 2] = C.z; md[k + 3] = D.x; md[k + 4] = D.y; md[k + 5] = D.z;
          md[k + 6] = R() * span; md[k + 7] = fire ? 1.5 + R() * 0.8 : 0.4 + R() * 0.45; md[k + 8] = 0.6 + R() * 0.4;
          md[k + 9] = fire; md[k + 10] = fire ? 0.32 + R() * 0.2 : 0.16 + R() * 0.2; md[k + 11] = fire ? (R() < 0.5 ? 0 : 1) : (R() * 4) | 0;
          last = Math.max(last, md[k + 6] + md[k + 7]);
        }
        ev.meteors.dur = last + 1.8;
        return true;
      },
      tick() {
        const L = 20000, t = this.t;
        for (let i = 0; i < mCount; i++) {
          const k = i * MS, age = t - md[k + 6], dur = md[k + 7];
          if (age <= 0) continue;
          const fire = md[k + 9] > 0.5, linger = fire ? 1.5 : 0.8, after = age - dur;
          if (after > linger) continue;
          const u = Math.min(1, age / dur), ang = md[k + 10] * u * (fire ? 1 - 0.25 * u : 1), cc = MCOL[md[k + 11] | 0], bb = md[k + 8];
          const dx = md[k + 3], dy = md[k + 4], dz = md[k + 5];
          const hx = (md[k] + dx * ang) * L, hy = (md[k + 1] + dy * ang) * L, hz = (md[k + 2] + dz * ang) * L;
          const sz = fire ? 115 : 62;
          // the train: from the head back along the path; it outlives the head and thins out
          const tf = after > 0 ? Math.exp(-after * (fire ? 2.2 : 3.6)) : 1, tl = -Math.min(ang, md[k + 10] * (fire ? 0.9 : 0.75)) * L;
          const tb = (fire ? 1.5 : 1.25) * bb * tf * Math.min(1, u * 5);
          self._blip(hx, hy, hz, dx * tl, dy * tl, dz * tl, cc[0] * tb, cc[1] * tb, cc[2] * tb, sz * (after > 0 ? 0.75 : 1), 1, 1);
          if (after > 0) { if (fire && after < 0.22) { const g = (1 - after / 0.22) * bb; self._blip(hx, hy, hz, 0, 0, 0, 9 * g, 8 * g, 6 * g, 900, 3, 1); } continue; }
          // the head: white-hot, short
          const hb = Math.sin(Math.PI * Math.min(1, u * 1.04)) ** 0.35 * bb * (fire ? 5 + 2.5 * Math.sin(t * 37 + i) : 5.5);
          const hl = -L * (fire ? 0.012 : 0.02);
          self._blip(hx, hy, hz, dx * hl, dy * hl, dz * hl, 1.6 * hb, 1.5 * hb, 1.25 * hb, sz * 0.8, 1, 1);
          if (fire) {
            self._blip(hx, hy, hz, 0, 0, 0, cc[0] * hb * 0.5, cc[1] * hb * 0.5, cc[2] * hb * 0.5, 420, 4, 1);
            if (u > 0.62) {   // breaking up: fragments peel away and fall behind
              const v = (u - 0.62) / 0.38, px = md[k + 1] * dz - md[k + 2] * dy, py = md[k + 2] * dx - md[k] * dz, pz = md[k] * dy - md[k + 1] * dx;
              for (let j = 0; j < 4; j++) {
                const sd = (j - 1.5) * 0.011 * v * L * (1 + 0.3 * j), lag = -(0.006 + 0.012 * ((j * 7) % 4)) * v * L, fb = hb * 0.45 * (1 - v * 0.6);
                self._blip(hx + px * sd + dx * lag, hy + py * sd + dy * lag, hz + pz * sd + dz * lag, dx * hl * 2, dy * hl * 2, dz * hl * 2, cc[0] * fb + fb * 0.4, cc[1] * fb + fb * 0.3, cc[2] * fb, 46, 1, 1);
              }
            }
          }
        }
        return t < this.dur;
      },
    });
    /* --- fleet engagement / skirmish --- */
    const SN = 12, sp = new Float32Array(SN * 3), sv = new Float32Array(SN * 3), sa = new Float32Array(SN * 6); // sa: alive, fire timer, scale, model, turn, seed
    const SHN = 10, sh = new Float32Array(SHN * 4); // from, to, t, on
    const BN = 6, bm = new Float32Array(BN * 5);    // x, y, z, t, size
    const fleet = { n: 0, skirm: false, free: true };
    const fleetStart = (skirm) => {
      fleet.free = this._place(C, 5200, 8000);
      A.copy(C).sub(cam).normalize();
      B.set(-A.z, 0, A.x).normalize();                // across the line of sight
      fleet.skirm = skirm; fleet.n = skirm ? 5 : 11;
      for (let i = 0; i < fleet.n; i++) {
        const side = i & 1, s = side ? 1 : -1, cap = !skirm && i === 0, k = i * 3, q = i * 6;
        const off = (skirm ? 380 : 850) + (R() - 0.5) * 500;
        sp[k] = C.x + B.x * s * off + A.x * (R() - 0.5) * 900; sp[k + 1] = C.y + (R() - 0.5) * 380; sp[k + 2] = C.z + B.z * s * off + A.z * (R() - 0.5) * 900;
        const v = cap ? 22 : skirm ? 120 + R() * 60 : 45 + R() * 40;
        sv[k] = -B.x * s * v + A.x * (R() - 0.5) * 20; sv[k + 1] = (R() - 0.5) * 8; sv[k + 2] = -B.z * s * v + A.z * (R() - 0.5) * 20;
        sa[q] = 1; sa[q + 1] = 0.6 + R() * 2; sa[q + 2] = cap ? 640 : !skirm && i === 1 ? 380 : skirm ? 120 + R() * 60 : 160 + R() * 100; sa[q + 3] = cap ? 2 : side ? 6 : 1;   // blue frigates + their flagship against bronze raiders
        sa[q + 4] = skirm ? (R() - 0.5) * 0.7 : 0; sa[q + 5] = R() * 9;
      }
      sh.fill(0); for (let i = 0; i < BN; i++) bm[i * 5 + 3] = -1;
      return true;
    };
    const fleetTick = (e, dt) => {
      const f = envl(e.t, e.dur, 1.5, 2.5), n = fleet.n, live = e.t < e.dur - 2.5;
      for (let i = 0; i < n; i++) {
        const k = i * 3, q = i * 6;
        if (sa[q + 4]) { const a = sa[q + 4] * dt, cs = Math.cos(a), sn = Math.sin(a), vx = sv[k], vz = sv[k + 2]; sv[k] = vx * cs - vz * sn; sv[k + 2] = vx * sn + vz * cs; }
        sp[k] += sv[k] * dt; sp[k + 1] += sv[k + 1] * dt; sp[k + 2] += sv[k + 2] * dt;
        if (sa[q] <= 0) continue;
        const h = yaw(sv[k], sv[k + 2]), s = sa[q + 2];
        this._inst(sa[q + 3], sp[k], sp[k + 1], sp[k + 2], 0, Math.sin(h), 0, Math.cos(h), s, s, s, f * sa[q], sa[q + 5], 1, i & 1);
        { const vl = s * 0.56 / (Math.hypot(sv[k], sv[k + 2]) || 1), g = f * sa[q] * (0.8 + 0.2 * Math.sin(e.t * 9 + i));   // engine glow
          if (i & 1) this._blip(sp[k] - sv[k] * vl, sp[k + 1], sp[k + 2] - sv[k + 2] * vl, 0, 0, 0, 2.6 * g, 0.9 * g, 0.25 * g, s * 0.14, 4, 0);
          else this._blip(sp[k] - sv[k] * vl, sp[k + 1], sp[k + 2] - sv[k + 2] * vl, 0, 0, 0, 0.5 * g, 1.2 * g, 2.8 * g, s * 0.14, 4, 0); }
        if (!live) continue;
        sa[q + 1] -= dt;
        if (sa[q + 1] <= 0) {
          sa[q + 1] = (fleet.skirm ? 0.35 : 0.6) + R() * 1.5;
          let tg = -1;
          for (let tr = 0; tr < 6 && tg < 0; tr++) { const j = (R() * n) | 0; if ((j & 1) !== (i & 1) && sa[j * 6] > 0) tg = j; }
          if (tg >= 0) for (let s2 = 0; s2 < SHN; s2++) if (!sh[s2 * 4 + 3]) { sh[s2 * 4] = i; sh[s2 * 4 + 1] = tg; sh[s2 * 4 + 2] = 0; sh[s2 * 4 + 3] = 1; break; }
        }
      }
      for (let s2 = 0; s2 < SHN; s2++) {
        const o = s2 * 4; if (!sh[o + 3]) continue;
        sh[o + 2] += dt / 0.32;
        const a = sh[o] * 3, b = sh[o + 1] * 3, u = Math.min(1, sh[o + 2]);
        const x = sp[a] + (sp[b] - sp[a]) * u, y = sp[a + 1] + (sp[b + 1] - sp[a + 1]) * u, z = sp[a + 2] + (sp[b + 2] - sp[a + 2]) * u;
        let dx = sp[a] - sp[b], dy = sp[a + 1] - sp[b + 1], dz = sp[a + 2] - sp[b + 2]; const l = 190 / (Math.hypot(dx, dy, dz) || 1);
        const side = sh[o] & 1;
        this._blip(x, y, z, dx * l, dy * l, dz * l, (side ? 2.6 : 0.5) * f, (side ? 0.5 : 2.6) * f, (side ? 2.8 : 1.0) * f, 9, 1, 0);
        if (u >= 1) {
          sh[o + 3] = 0;
          const tq = sh[o + 1] * 6, big = sa[tq + 3] === 2;
          let foes = 0; for (let j = 0; j < n; j++) if ((j & 1) === (sh[o + 1] & 1) && sa[j * 6] > 0) foes++;
          const kill = !big && foes > 1 && e.t > 2.5 && R() < (fleet.skirm ? 0.22 : 0.14);
          for (let k2 = 0; k2 < BN; k2++) if (bm[k2 * 5 + 3] < 0) { bm[k2 * 5] = x; bm[k2 * 5 + 1] = y; bm[k2 * 5 + 2] = z; bm[k2 * 5 + 3] = 0; bm[k2 * 5 + 4] = kill ? 1 : 0.22; break; }
          if (kill) sa[tq] = 0;
        }
      }
      for (let k2 = 0; k2 < BN; k2++) {
        const o = k2 * 5; if (bm[o + 3] < 0) continue;
        bm[o + 3] += dt;
        const t = bm[o + 3], s = bm[o + 4], life = 0.5 + s * 1.3;
        if (t > life) { bm[o + 3] = -1; continue; }
        const u = t / life, g = (1 - u) * (1 - u) * f;
        this._blip(bm[o], bm[o + 1], bm[o + 2], 0, 0, 0, 4.5 * g * s, 2.4 * g * s, 0.9 * g * s, 60 + 330 * s * Math.sqrt(u), 4, 0);
        if (t < 0.16) this._blip(bm[o], bm[o + 1], bm[o + 2], 0, 0, 0, 6 * s, 5 * s, 4 * s, 260 * s + 40, 3, 0);
      }
      return e.t < e.dur;
    };
    def('battle', { big: true, loud: true, w: [0, 0.5, 1], start() { this.dur = 12 + R() * 4; return fleetStart(false); }, tick(dt) { return fleetTick(this, dt); } });
    def('skirmish', { big: true, w: [0, 0.5, 1], start() { this.dur = 7.5 + R() * 2.5; return fleetStart(true); }, tick(dt) { return fleetTick(this, dt); } });

    /* --- convoy: a line of freighters with a frigate escort on either flank --- */
    const cv = { n: 5, a: V3(), d: V3(), len: 1, sc: 220, seed: 0 };
    def('convoy', {
      big: true, w: [0.2, 0.6, 1],
      start() {
        self._place(C, 4600, 7200);
        A.copy(C).sub(cam).normalize(); B.set(-A.z, 0, A.x).normalize();
        const s = R() < 0.5 ? -1 : 1;
        cv.d.copy(B).multiplyScalar(s).addScaledVector(A, (R() - 0.5) * 0.5).normalize(); cv.d.y = (R() - 0.5) * 0.06;
        cv.len = 3400; cv.a.copy(C).addScaledVector(cv.d, -cv.len / 2);
        cv.n = 5 + ((R() * 3) | 0); cv.sc = 230 + R() * 80; cv.seed = R() * 9;
        this.dur = 26 + R() * 6;
        return true;
      },
      tick() {
        const gap = cv.sc * 1.45, total = cv.len + gap * cv.n, h = yaw(cv.d.x, cv.d.z), sh2 = Math.sin(h), ch = Math.cos(h);
        for (let i = 0; i < cv.n + 2; i++) {
          const esc = i >= cv.n, j = esc ? (i - cv.n ? cv.n - 2 : 1) : i;
          const s = (this.t / this.dur) * total - j * gap;
          const f = clamp01(Math.min(s, cv.len - s) / 500);
          if (f <= 0) continue;
          const side = esc ? (i - cv.n ? 1 : -1) * cv.sc * 1.5 : 0;
          const sc = cv.sc * (esc ? 0.62 : i === 0 ? 1.25 : 1), x = cv.a.x + cv.d.x * s - cv.d.z * side, y = cv.a.y + cv.d.y * s + Math.sin(i * 2.3) * 30 + (esc ? cv.sc * 0.35 : 0), z = cv.a.z + cv.d.z * s + cv.d.x * side;
          self._inst(esc ? 1 : 0, x, y, z, 0, sh2, 0, ch, sc, sc, sc, f, cv.seed + i, 1);
          const bl = (Math.sin(this.t * 4.2 + i * 1.7) > 0.55 ? 1 : 0.08) * f, st = sc * 0.5, g = f * (0.85 + 0.15 * Math.sin(this.t * 11 + i));
          self._blip(x + cv.d.x * st, y + sc * 0.03, z + cv.d.z * st, 0, 0, 0, 2.6 * bl, 0.25 * bl, 0.2 * bl, sc * 0.03, 0, 0);
          if (!esc) self._blip(x - cv.d.x * st * 0.88, y + sc * 0.14, z - cv.d.z * st * 0.88, 0, 0, 0, 0.3 * f, 1.9 * f, 0.7 * f, sc * 0.022, 0, 0);
          self._blip(x - cv.d.x * st * 1.16, y, z - cv.d.z * st * 1.16, 0, 0, 0, 0.5 * g, 1.1 * g, 2.6 * g, sc * 0.13, 4, 0);
        }
        return this.t < this.dur;
      },
    });

    /* --- a capital ship sliding by under the lane --- */
    const cp = { x: 0, y: 0, z: 0, L: 1100, v: 70, seed: 0 };
    def('capital', {
      big: true, w: [1, 1, 0.7],
      start() {
        cp.L = 1000 + R() * 350; cp.v = 62 + R() * 18; cp.seed = R() * 9;
        // top / tilt: it enters at the right edge of the picture and leaves at the left one — the whole length passes by
        const hw = self._W / 2, x0 = self._view === 2 ? 3700 : hw + cp.L * 0.5 + 520;
        cp.x = x0; cp.y = -(620 + R() * 260); cp.z = (R() < 0.5 ? -1 : 1) * (120 + R() * 330);
        this.dur = Math.min(70, (x0 + hw + cp.L * 0.5 + 420) / cp.v);
        return true;
      },
      tick(dt) {
        cp.x -= cp.v * dt;
        const f = envl(this.t, this.dur, 4, 5);
        self._inst(2, cp.x, cp.y, cp.z, 0, 0, 0, 1, cp.L, cp.L, cp.L, f, cp.seed, 1);
        const bl = (this.t % 1.6 < 0.12 ? 1 : 0) * f, L = cp.L, g = f * (0.85 + 0.15 * Math.sin(this.t * 7));
        self._blip(cp.x + L * 0.5, cp.y, cp.z, 0, 0, 0, 2.5 * bl, 2.5 * bl, 2.8 * bl, 12, 0, 0);
        self._blip(cp.x - L * 0.282, cp.y + L * 0.175, cp.z, 0, 0, 0, 2.6 * bl, 0.3 * bl, 0.25 * bl, 10, 0, 0);
        self._blip(cp.x - L * 0.2, cp.y, cp.z + L * 0.17, 0, 0, 0, 0.25 * f, 2.2 * f, 0.5 * f, 8, 0, 0);
        self._blip(cp.x - L * 0.2, cp.y, cp.z - L * 0.17, 0, 0, 0, 2.4 * f, 0.25 * f, 0.2 * f, 8, 0, 0);
        self._blip(cp.x - L * 0.57, cp.y - L * 0.012, cp.z, 0, 0, 0, 0.5 * g, 1.1 * g, 2.6 * g, L * 0.12, 4, 0);
        return this.t < this.dur;
      },
    });

    /* --- an asteroid belt tumbling by far below --- */
    const RN = this.lo ? 22 : 40, rk = new Float32Array(RN * 12);
    def('rocks', {
      big: true, w: [1, 1, 0.8],
      start() {
        const x0 = self._view === 2 ? 2600 : 1700;
        for (let i = 0; i < RN; i++) {
          const k = i * 12, s = 25 + R() * R() * 110;
          rk[k] = x0 + R() * 4300; rk[k + 1] = -(1300 + R() * 1200); rk[k + 2] = (R() - 0.5) * (self._view === 2 ? 5200 : 2600);
          A.set(R() - 0.5, R() - 0.5, R() - 0.5).normalize(); rk[k + 3] = A.x; rk[k + 4] = A.y; rk[k + 5] = A.z;
          rk[k + 6] = 0.1 + R() * 0.5; rk[k + 7] = s * (0.7 + R() * 0.6); rk[k + 8] = s * (0.6 + R() * 0.5); rk[k + 9] = s;
          rk[k + 10] = 95 + R() * 45; rk[k + 11] = R() * 9;
        }
        this.dur = 42;
        return true;
      },
      tick(dt) {
        const f = envl(this.t, this.dur, 3, 4);
        for (let i = 0; i < RN; i++) {
          const k = i * 12;
          rk[k] -= rk[k + 10] * dt;
          const a = (this.t * rk[k + 6] + rk[k + 11]) * 0.5, sn = Math.sin(a);
          self._inst(4 + (i & 1), rk[k], rk[k + 1], rk[k + 2], rk[k + 3] * sn, rk[k + 4] * sn, rk[k + 5] * sn, Math.cos(a), rk[k + 7], rk[k + 8], rk[k + 9], f, rk[k + 11], 0);
        }
        return this.t < this.dur;
      },
    });

    /* --- orbital station: a resident of the sector (see _placeStation / _tickStation). The event
           brings one in over the limb of its planet if the sector has none yet, and stirs up traffic --- */
    def('station', {
      big: true, w: [0.6, 0.6, 1],
      start(o) {
        const st = self._stn;
        if (!st.on) {
          const p = o.planet != null ? self._pickPlanet([o.planet]) : self._pickPlanet(self._view === 2 ? [1, 2, 0] : [0, 2, 1]);
          if (!p) return false;
          self._placeStation(p, true);
        }
        st.boost = 1; this.dur = 30;
        return true;
      },
      tick() { return this.t < this.dur && self._stn.on; },
      stop() { self._stn.boost = 0; },
    });

    /* --- jump point: space tears open, a ship drops out of it (or runs into it and is gone) --- */
    const gt = { c: V3(), d: V3(), arrive: true, seed: 0, mdl: 1, sc: 200 };
    def('gate', {
      big: true, w: [0, 0.4, 0.8],
      start() {
        self._place(gt.c, 4500, 7500);
        A.copy(gt.c).sub(cam).normalize(); gt.d.set(-A.z, 0, A.x).normalize().multiplyScalar(R() < 0.5 ? -1 : 1).addScaledVector(A, (R() - 0.5) * 0.6).normalize();
        gt.arrive = R() < 0.55; gt.seed = R() * 9; this.dur = gt.arrive ? 8.5 : 6;
        gt.mdl = R() < 0.3 ? 0 : R() < 0.5 ? 6 : 1; gt.sc = gt.mdl === 0 ? 300 : 220;
        return true;
      },
      tick() {
        const t = this.t, c = gt.c, d = gt.d, T0 = gt.arrive ? 1.6 : 4;
        const open = gt.arrive ? smooth(clamp01(t / 1.6)) * (1 - smooth(clamp01((t - 2) / 2))) : smooth(clamp01((t - 2.2) / 1.6)) * (1 - smooth(clamp01((t - 4.1) / 1.2)));
        const sh2 = 0.75 + 0.25 * Math.sin(t * 23);
        if (open > 0.01) {
          self._blip(c.x, c.y, c.z, 0, 0, 0, 1.3 * open * sh2, 0.7 * open * sh2, 3 * open * sh2, 300 * open, 2, 0);
          self._blip(c.x, c.y, c.z, 0, 0, 0, 0.5 * open * (1.5 - sh2), 0.9 * open, 2.4 * open, 190 * open * (0.9 + 0.1 * Math.sin(t * 9)), 2, 0);
          self._blip(c.x, c.y, c.z, 0, 0, 0, 0.25 * open, 0.15 * open, 0.6 * open, 260 * open, 4, 0);
          for (let i = 0; i < 5; i++) {   // matter spiralling in
            const a = t * (2.2 + i * 0.4) + i * 1.9, r = 300 * open * (1 - ((t * 0.7 + i * 0.2) % 1) * 0.8), g = open * 0.9;
            self._blip(c.x - d.z * Math.cos(a) * r, c.y + Math.sin(a) * r, c.z + d.x * Math.cos(a) * r, 0, 0, 0, 0.7 * g, 0.9 * g, 2.2 * g, 14, 0, 0);
          }
        }
        const fl = Math.exp(-Math.abs(t - T0) * (t < T0 ? 14 : 3.5));
        self._blip(c.x, c.y, c.z, 0, 0, 0, 4 * fl, 3.4 * fl, 6 * fl, 420, 3, 0);
        let s, op;
        if (gt.arrive) { const u = t - T0; if (u < 0) return true; s = 1100 * (1 - Math.exp(-u * 1.3)) + 120 * u; op = Math.min(1, u * 5) * clamp01((this.dur - t) / 2); }
        else { if (t > T0) return t < this.dur; const u = t / T0; s = -1500 * (1 - u * u); op = Math.min(1, t * 0.8); }
        const h = yaw(d.x, d.z), x = c.x + d.x * s, z = c.z + d.z * s, sc = gt.sc;
        self._inst(gt.mdl, x, c.y, z, 0, Math.sin(h), 0, Math.cos(h), sc, sc, sc, op, gt.seed, 1, gt.mdl === 6 ? 1 : 0);
        if (gt.mdl === 6) self._blip(x - d.x * sc * 0.58, c.y, z - d.z * sc * 0.58, 0, 0, 0, 2.6 * op, 0.9 * op, 0.25 * op, sc * 0.14, 4, 0);
        else self._blip(x - d.x * sc * 0.58, c.y, z - d.z * sc * 0.58, 0, 0, 0, 0.5 * op, 1.2 * op, 2.8 * op, sc * 0.14, 4, 0);
        return t < this.dur;
      },
    });

    /* --- the sun: flare / prominence + corona pulse --- */
    def('flare', {
      big: true, loud: true, w: [0, 0, 0.9],
      start(o) {
        if (!o.force && self._cam) { A.copy(self.sunSkyDirection).multiplyScalar(1000).add(cam).project(self._cam); if (Math.abs(A.x) > 1.05 || Math.abs(A.y) > 1.05 || A.z > 1) return false; }
        self.skyU.uFlare.value.set(0.5 + R() * 2.1, 0, 0.9 + R() * 0.6, R() < 0.6 ? 1 : 0.3);   // on the upper limb: the lower one hides behind the lane
        this.dur = 14 + R() * 5;
        return true;
      },
      tick() { const u = clamp01(this.t / this.dur); self.skyU.uFlare.value.y = smooth(clamp01(u / 0.45)) * (1 - smooth(clamp01((u - 0.72) / 0.28))) * self._evGain * self._dipK; return this.t < this.dur; },
      stop() { self.skyU.uFlare.value.y = 0; },
    });

    /* --- far nova: a new star for a few seconds, the nebula catches its light --- */
    const nv = { d: V3(), c: new THREE.Color(), free: true };
    const glowOff = () => { self.skyU.uGlowC.value.setRGB(0, 0, 0); self.skyU.uGlowC2.value.setRGB(0, 0, 0); };
    def('nova', {
      big: true, loud: true, w: [0.4, 0.5, 0.6],
      start() {
        nv.free = self._skySpot(nv.d);
        if (!nv.free) self._viewDir(nv.d, (R() * 2 - 1) * 0.8, (R() * 2 - 1) * 0.8);
        const k = R(); nv.c.setRGB(k < 0.4 ? 0.7 : 1.1, k < 0.4 ? 0.85 : 0.75, k < 0.4 ? 1.3 : 0.8);
        this.dur = 9;
        return true;
      },
      tick() {
        const t = this.t, e = (t < 0.35 ? t / 0.35 : Math.exp(-(t - 0.35) * 0.6)) * clamp01((this.dur - t) / 1.5) * self._evGain, L = 20000;
        self._blip(nv.d.x * L, nv.d.y * L, nv.d.z * L, 0, 0, 0, nv.c.r * 9 * e, nv.c.g * 9 * e, nv.c.b * 9 * e, 700 * (0.4 + 0.6 * e), 3, 1);
        self.skyU.uGlowD.value.set(nv.d.x, nv.d.y, nv.d.z, 5);
        self.skyU.uGlowC.value.copy(nv.c).multiplyScalar(0.16 * e);
        return t < this.dur;
      },
      stop: glowOff,
    });

    /* --- pulsar: a lighthouse far away --- */
    const ps = { d: V3(), a1: V3(), a2: V3() };
    def('pulsar', {
      big: true, w: [0, 0.3, 0.6],
      start() {
        if (!self._skySpot(ps.d)) return false;
        ps.a1.set(R() - 0.5, R() - 0.5, R() - 0.5); ps.a1.addScaledVector(ps.d, -ps.a1.dot(ps.d)).normalize();
        ps.a2.crossVectors(ps.d, ps.a1).multiplyScalar(0.35).addScaledVector(ps.d, 0.94).normalize();
        this.dur = 16;
        return true;
      },
      tick() {
        const f = envl(this.t, this.dur, 2, 3), w = this.t * 3.9, cs = Math.cos(w), sn = Math.sin(w), L = 20000, d = ps.d;
        const ax = ps.a1.x * cs + ps.a2.x * sn, ay = ps.a1.y * cs + ps.a2.y * sn, az = ps.a1.z * cs + ps.a2.z * sn;
        const face = Math.abs(ax * d.x + ay * d.y + az * d.z), pulse = Math.pow(face, 10);
        const g = (0.8 + 6 * pulse) * f, bl = 3600, bb = 1.1 * f * (1 - 0.6 * face);
        self._blip(d.x * L, d.y * L, d.z * L, 0, 0, 0, 0.8 * g, 1.0 * g, 1.6 * g, 240 + 160 * pulse, 3, 1);
        self._blip(d.x * L, d.y * L, d.z * L, ax * bl, ay * bl, az * bl, 0.45 * bb, 0.6 * bb, 1.2 * bb, 26, 1, 1);
        self._blip(d.x * L, d.y * L, d.z * L, -ax * bl, -ay * bl, -az * bl, 0.45 * bb, 0.6 * bb, 1.2 * bb, 26, 1, 1);
        return this.t < this.dur;
      },
    });

    /* --- nebula weather: sheet lightning that lights the cloud volume from inside (two cells
           flickering independently), and now and then a bolt you can actually see --- */
    const sm = { d: [V3(), V3(), V3()], free: [false, false, false], k: [0, 1], i: [0, 0], next: [0.3, 0.9], re: [0, 0], col: new THREE.Color() };
    def('storm', {
      big: true, w: [0.8, 0.8, 0.8],
      start() {
        for (let k = 0; k < 3; k++) {
          sm.free[k] = self._skySpot(sm.d[k]);
          if (!sm.free[k]) self._viewDir(sm.d[k], (R() * 2 - 1) * 0.85, (R() * 2 - 1) * 0.85);
          else if (k > 0) sm.d[k].lerp(sm.d[0], 0.45).normalize();     // one storm system, not three unrelated flashes
        }
        sm.i[0] = sm.i[1] = 0; sm.next[0] = 0.3; sm.next[1] = 0.8; sm.k[0] = 0; sm.k[1] = 1; this.dur = 9 + R() * 5;
        sm.col.copy(self._pal.nebC).multiplyScalar(2.2).lerp(self._c.setRGB(0.6, 0.75, 1.25), 0.6);
        return true;
      },
      tick(dt) {
        const gu = self.skyU, live = this.t < this.dur - 1, topK = self._view === 0 ? 0.3 : 1;
        for (let c = 0; c < 2; c++) {
          sm.next[c] -= dt;
          if (sm.next[c] <= 0 && live) {
            const strobe = R() < 0.5;
            sm.next[c] = strobe ? 0.06 + R() * 0.1 : 0.45 + R() * 1.5;
            if (!strobe || R() < 0.3) sm.k[c] = (R() * 3) | 0;
            sm.i[c] = 0.7 + R() * 0.9;
            const d = sm.d[sm.k[c]];
            if (sm.free[sm.k[c]] && sm.i[c] > 1.05 && R() < 0.6) {   // a visible stroke between two points of the cloud
              const Lb = 9000, len = 1500 + R() * 1900;
              A.set(R() - 0.5, (R() - 0.5) * 1.6, R() - 0.5); A.addScaledVector(d, -A.dot(d)).normalize();
              B.copy(d).multiplyScalar(Lb).add(cam).addScaledVector(A, (R() - 0.6) * len);
              const b = self._bolt(B.x, B.y, B.z, B.x + A.x * len, B.y + A.y * len, B.z + A.z * len, len * 0.045, 20, len * 0.05, 0.3 + R() * 0.2);
              b.sky = true; b.u.uBoltCol.value.copy(sm.col).multiplyScalar(3.2 * self._evGain);
            }
          }
          sm.i[c] *= Math.exp(-dt * 6.5);
          const d = sm.d[sm.k[c]], e = sm.i[c] * self._evGain * self._dipK * topK * 0.6;
          (c ? gu.uGlowD2 : gu.uGlowD).value.set(d.x, d.y, d.z, c ? 60 : 24);
          (c ? gu.uGlowC2 : gu.uGlowC).value.copy(sm.col).multiplyScalar(e);
        }
        return this.t < this.dur;
      },
      stop: glowOff,
    });

    /* --- aurora ripples on a planet --- */
    const au = { p: null };
    def('aurora', {
      big: true, w: [0.8, 0.8, 0.8],
      start(o) {
        au.p = o.planet != null ? self._pickPlanet([o.planet]) : self._pickPlanet(self._view === 2 ? [1, 0, 2] : [0, 2, 1], true);
        this.dur = 22;
        return !!au.p;
      },
      tick() { au.p.aurBoost = Math.sin(Math.PI * clamp01(this.t / this.dur)) * 2.4; return this.t < this.dur; },
      stop() { if (au.p) au.p.aurBoost = 0; },
    });

    /* --- a moon crossing the face of its planet (on demand; it also happens by itself every orbit) --- */
    def('transit', {
      w: [0, 0, 0],
      start(o) {
        const p = o.planet != null ? self._pickPlanet([o.planet]) : self._pickPlanet(self._view === 2 ? [1, 0, 2] : [0, 1, 2]);
        if (!p) return false;
        for (const m of p.moons) if (m.on) { m.a = -Math.asin(Math.min(0.95, (p.R * 0.9) / m.D)); this.dur = 10; return true; }
        return false;
      },
      tick() { return this.t < this.dur; },
    });

    this._stn = { on: false, p: null, a: 0, q: new THREE.Quaternion(), pos: V3(), e1: V3(), e2: V3(), tr: new Float32Array(8 * 5), boost: 0, t: 0, S: 200 };
    this.eventNames = Object.keys(ev);
    this._evList = this.eventNames.map((k) => ev[k]);
  }

  // Put the sector's station into orbit around planet p. The orbit passes behind the planet
  // as seen from the play field; `behind` starts it just inside the limb, so it rises into view.
  _placeStation(p, behind) {
    const st = this._stn, R = this._rand, cam = this._cam ? this.U.uCam.value : this._v.set(-200, 420, 0);
    st.e1.copy(cam).sub(p.pos).normalize();
    st.e2.set(-st.e1.z, 0, st.e1.x).normalize();
    this._v2.crossVectors(st.e1, st.e2);
    st.e2.addScaledVector(this._v2, (R() - 0.5) * 0.9).normalize();
    st.p = p; st.on = true; st.t = 0; st.boost = 0;
    st.a = behind ? Math.PI + 0.715 : Math.PI + 0.95 + R() * 4.3;      // hidden for |a - π| < 0.73
    st.S = Math.min(520, Math.max(140, p.R * 0.34));
    st.q.setFromAxisAngle(this._v2.set(R() - 0.5, 0.25, R() - 0.5).normalize(), 0.5 + R() * 0.7);
    for (let i = 0; i < 8; i++) {
      const a = ((i % 3) / 3) * Math.PI * 2 + 0.52;   // shuttles use the docking arms
      st.tr[i * 5] = Math.cos(a); st.tr[i * 5 + 1] = -0.19 + (R() - 0.5) * 0.3; st.tr[i * 5 + 2] = -Math.sin(a); st.tr[i * 5 + 3] = R(); st.tr[i * 5 + 4] = 5 + R() * 6;
    }
  }

  _tickStation(dt) {
    const st = this._stn, p = st.p;
    if (!st.on) return;
    if (!p.on) { st.on = false; return; }
    st.t += dt; st.a += dt * 0.017;
    const S = st.S, f = p.op, D = p.R * 1.5, ca = Math.cos(st.a) * D, sa = Math.sin(st.a) * D, cam = this.U.uCam.value;
    const P = st.pos.copy(p.pos).addScaledVector(st.e1, ca).addScaledVector(st.e2, sa);
    const q = this._q.setFromAxisAngle(this._Y, st.t * 0.11).premultiply(st.q);
    this.shipU.uOcc.value.set(p.pos.x, p.pos.y, p.pos.z, p.R);
    this._inst(3, P.x, P.y, P.z, q.x, q.y, q.z, q.w, S, S, S, f, 3.3, 1, 0, 1);
    // is the hub behind the planet? (lights are sprites: they have to be hidden by hand)
    const rd = this._v.copy(P).sub(cam), dC = rd.length(); rd.multiplyScalar(1 / dC);
    const co = this._v2.copy(cam).sub(p.pos), bb = co.dot(rd), hh = bb * bb - (co.lengthSq() - p.R * p.R);
    let vis = f;
    if (hh > 0 && -bb - Math.sqrt(hh) < dC) vis = 0; else if (hh <= 0 && -bb < dC) vis *= smooth(clamp01((Math.sqrt(p.R * p.R - hh) - p.R) / (S * 0.5)));
    if (vis <= 0.01) return;
    const Y = this._v3.set(0, 1, 0).applyQuaternion(q);
    const strobe = (st.t % 1.5 < 0.09 ? 1 : 0) * vis;
    this._blip(P.x + Y.x * S * 0.64, P.y + Y.y * S * 0.64, P.z + Y.z * S * 0.64, 0, 0, 0, 3 * strobe, 3 * strobe, 3.4 * strobe, S * 0.05, 0, 0);
    this._blip(P.x - Y.x * S * 0.47, P.y - Y.y * S * 0.47, P.z - Y.z * S * 0.47, 0, 0, 0, 1.6 * vis, 0.5 * vis, 0.15 * vis, S * 0.07, 4, 0);
    const X = this._v.set(1, 0, 0).applyQuaternion(q), Z = this._v2.set(0, 0, 1).applyQuaternion(q);
    const rb = (Math.sin(st.t * 2.6) > 0.3 ? 1 : 0.12) * vis;
    this._blip(P.x + X.x * S, P.y + X.y * S, P.z + X.z * S, 0, 0, 0, 2.4 * rb, 0.25 * rb, 0.2 * rb, S * 0.03, 0, 0);
    this._blip(P.x - X.x * S, P.y - X.y * S, P.z - X.z * S, 0, 0, 0, 0.25 * rb, 2.2 * rb, 0.6 * rb, S * 0.03, 0, 0);
    const n = st.boost > 0 ? 8 : 3;
    for (let i = 0; i < n; i++) {   // shuttles coming and going along the docking arms
      const k = i * 5, u0 = (st.t / st.tr[k + 4] + st.tr[k + 3]) % 1, u = i & 1 ? u0 : 1 - u0, d = S * (0.95 + 6.5 * u * u), g = vis * Math.min(1, (1 - u) * 5, u * 8) * 0.9;
      const lx = st.tr[k], ly = st.tr[k + 1], lz = st.tr[k + 2];
      const wx = X.x * lx + Y.x * ly + Z.x * lz, wy = X.y * lx + Y.y * ly + Z.y * lz, wz = X.z * lx + Y.z * ly + Z.z * lz, tl = (i & 1 ? -1 : 1) * S * 0.3 * u;
      this._blip(P.x + wx * d, P.y + wy * d, P.z + wz * d, wx * tl, wy * tl, wz * tl, 0.9 * g, 1.1 * g, 1.6 * g, S * 0.02, 1, 0);
    }
  }

  /**
   * Trigger an ambient event by name (see `eventNames`). Returns false when it
   * cannot run right now (unknown, already running, another big one is on,
   * hyperspace, sector crossfade, or nowhere to put it). opts: { force, planet, count }.
   */
  event(name, opts) {
    const e = this._events && this._events[name], o = opts || NOOPTS;
    if (!e || !this._cam || this._warpHi || this._fade < 1) return false;
    if (e.on) return false;
    if (e.big && this._evBig) {
      if (!o.force) return false;
      this._endEvent(this._evBig);
    }
    e.t = 0;
    if (!e.start(o)) return false;
    e.on = true;
    if (e.big) this._evBig = e;
    return true;
  }

  _endEvent(e) {
    e.on = false;
    if (e.stop) e.stop();
    if (this._evBig === e) this._evBig = null;
    if (e.name === 'comet' || e.name === 'cometImpact') { this._comet.on = false; this._comet.impact = null; this.cometMesh.visible = this.cometMesh2.visible = false; this._ej.on = false; }
  }

  _stopEvents() {
    if (!this._evList) return;
    for (const e of this._evList) if (e.on) this._endEvent(e);
    this._comet.on = false; this._comet.impact = null; this._ej.on = false;
    this.cometMesh.visible = this.cometMesh2.visible = false;
    this._nb = 0; this._kitShips.n = this._kitRocks.n = 0;
    this._blipGeo.instanceCount = 0; this._kitShips.geo.instanceCount = 0; this._kitRocks.geo.instanceCount = 0;
    this.blips.visible = this.shipsMesh.visible = this.rocksMesh.visible = false;
  }

  _tickEvents(dt, state) {
    const R = this._rand, list = this._evList;
    this._warpHi = (state.warpMul ?? 1) > 2;
    this._evGain += ((this._warpHi ? 0 : 1) - this._evGain) * (1 - Math.exp(-dt * 5));
    if (this._warpHi && this._evGain < 0.03) this._stopEvents();
    this._nb = 0; this._kitShips.n = this._kitRocks.n = 0; this._dNear = Infinity; this._dFar = -Infinity;
    let big = false;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e.on) continue;
      e.t += dt;
      if (!e.tick(dt)) this._endEvent(e);
      else if (e.big) big = true;
    }
    // ejecta of a comet strike
    const ej = this._ej;
    if (ej.on) {
      ej.t += dt;
      const p = ej.p, t = ej.t;
      if (t > 6 || !p.on) ej.on = false;
      else {
        const g = Math.exp(-t * 0.7) * (1 - t / 6);
        for (let k = 0; k < 10; k++) {
          const d = p.R * (0.04 + ej.s[k] * 0.55 * (1 - Math.exp(-t * 0.6)));
          const x = p.pos.x + ej.n.x * p.R + ej.d[k * 3] * d, y = p.pos.y + ej.n.y * p.R + ej.d[k * 3 + 1] * d, z = p.pos.z + ej.n.z * p.R + ej.d[k * 3 + 2] * d;
          this._blip(x, y, z, 0, 0, 0, 2.6 * g, 1.5 * g, 0.7 * g, p.R * (0.035 + 0.03 * t) * (0.6 + ej.s[k]), 4, 0);
        }
        if (t < 0.5) { const f = 1 - t / 0.5; this._blip(p.pos.x + ej.n.x * p.R, p.pos.y + ej.n.y * p.R, p.pos.z + ej.n.z * p.R, 0, 0, 0, 8 * f, 7 * f, 5 * f, p.R * 0.5, 3, 0); }
      }
    }
    // the scheduler: something notable every ~15–40 s, never two big ones at once
    if (this.opts.autoEvents && dt > 0 && !this._warpHi && this._fade >= 1 && this._cam) {
      const calm = state.intense ? 0.4 : 1;
      if (!big) this._evTimer -= dt * calm * this.opts.eventRate;
      if (this._evTimer <= 0) {
        this._evTimer = 3;
        const v = this._view;
        let tot = 0;
        for (let i = 0; i < list.length; i++) { const e = list[i]; tot += e.on || (state.intense && e.loud) ? 0 : e.w[v]; }
        for (let tr = 0; tr < 4 && tot > 0; tr++) {
          let x = R() * tot, pick = null;
          for (let i = 0; i < list.length; i++) { const e = list[i], w = e.on || (state.intense && e.loud) ? 0 : e.w[v]; if (w <= 0) continue; x -= w; if (x <= 0) { pick = e; break; } }
          if (pick && this.event(pick.name)) { this._evTimer = pick.big ? 9 + R() * 14 : 7 + R() * 9; break; }
        }
      }
      this._minorT -= dt * calm * this.opts.eventRate;
      if (this._minorT <= 0) { this._minorT = 8 + R() * 13; if (this._view > 0) this.event('meteors', this._one); }
    }
    // upload
    this._tickStation(dt);
    const di = this.debugInst;
    if (di) this._inst(di[0], di[1], di[2], di[3], di[4], di[5], di[6], di[7], di[8], di[8], di[8], 1, di[9] || 0, 1, di[10] || 0);
    const nb = this._nb, bg = this._blipGeo;
    bg.instanceCount = nb; this.blips.visible = nb > 0;
    if (nb > 0) { bg.attributes.aP.needsUpdate = bg.attributes.aQ.needsUpdate = bg.attributes.aK.needsUpdate = true; }
    this._flushKit(this._kitShips); this._flushKit(this._kitRocks);
    if (this._dFar > this._dNear) { const n = Math.max(20, this._dNear); this.shipU.uDR.value.set(n, Math.max(this._dFar, n * 1.02)); }
  }

  /** Drop transient effects (bolts, flashes, comet, running events). Sector stays. */
  clear() {
    for (const b of this.bolts) { b.on = false; b.mesh.visible = false; }
    this._flash = 0;
    this.U.uFlashC.value.setRGB(0, 0, 0);
    this.skyU.uSkyFlash.value.setRGB(0, 0, 0);
    this._stopEvents();
    this.skyU.uGlowC.value.setRGB(0, 0, 0); this.skyU.uGlowC2.value.setRGB(0, 0, 0); this.skyU.uFlare.value.y = 0; this._kick = 0;
    for (const p of this.planets) { p.imp = -1; p.body.u.uImp.value.w = -1; p.aurBoost = 0; }
    this._boltTimer = 1.5;
    this.U.uLN.value = 0;
  }

  dispose() {
    this._unbind();
    this.scene.remove(this.group);
    for (const d of this._disposables) d.dispose();
    this._disposables.length = 0;
  }

  /* ---------------------------------- update --------------------------------- */

  update(dtMs, camera, state = {}) {
    const U = this.U, P = this._pal;
    const paused = !!state.paused;
    const dt = paused ? 0 : Math.min(Math.max(dtMs || 0, 0), 100) / 1000;
    const speed = state.speedMul ?? 1, warpMul = Math.max(1, state.warpMul ?? 1);
    const mode = state.mode || 'tilt';
    if (state.W && state.H) { this._W = state.W; this._H = state.H; }
    const hw = this._W / 2, hh = this._H / 2;
    U.uField.value.set(hw, hh, this.opts.fieldDim, 0);

    // eased state
    const ease = (cur, tgt, rate) => cur + (tgt - cur) * (1 - Math.exp(-dt * rate));
    this._warp = ease(this._warp, clamp01((warpMul - 1) / 27), warpMul > 1.01 ? 5 : 2.6);
    this._ion = ease(this._ion, clamp01(state.ion || 0), 3);
    this._ecl = ease(this._ecl, clamp01(state.eclipse || 0), 4);
    const laneT = mode === 'chase' ? 1 : mode === 'top' ? 0.07 : 0.55;
    if (!this._laneInit) { this._lane = laneT; this._laneInit = true; this._ion = clamp01(state.ion || 0); this._ecl = clamp01(state.eclipse || 0); }
    this._lane = ease(this._lane, laneT, 3.2);
    const warp = this._warp;

    this._clock += dt * speed;
    const flow = dt * speed * (1 + (warpMul - 1) * 0.9) * SCROLL;
    this._scroll += flow;
    this._warpT += dt * (0.4 + warp * 9);
    if (this._scroll > 1.024e6) this._scroll -= 1.024e6; // keep float precision (a multiple of the lane periods; fog/dust pop once, ~2 h in)
    U.uTime.value = this._clock;
    U.uScroll.value = this._scroll;
    U.uWarp.value = warp; U.uWarpT.value = this._warpT;
    U.uIon.value = this._ion; U.uEclipse.value = this._ecl;

    // sector crossfade
    let dip = 1;
    if (this._fade < 1) {
      this._fade = Math.min(1, this._fade + dt / 1.5);
      const f = this._fade;
      if (f >= 0.5 && !this._fadeSwapped) { this._fadeSwapped = true; this._applySector(); }
      this._lerpPal(P, this._palFrom, this._palTo, smooth(f));
      dip = smooth(Math.abs(2 * f - 1));
      this.sunDirection.copy(this._keyFrom).lerp(this._keyTo, smooth(f)).normalize();
    }
    U.uDip.value = dip;

    // camera-derived
    camera.updateMatrixWorld();
    const cam = U.uCam.value.setFromMatrixPosition(camera.matrixWorld);
    const fwd = this._v.set(0, 0, -1).transformDirection(camera.matrixWorld);
    this._cam = camera; this._fwd.copy(fwd);
    this._view = fwd.y < -0.85 ? 0 : fwd.y < -0.5 ? 1 : 2; // looking straight down / tilted / at the horizon
    const fwdX = fwd.x, fwdZ = fwd.z;
    if (this._renderer && this._fadeSwapped) {
      // first impression: the planet this camera is looking at is baked at once, before the very first frame
      // is drawn (≈ 2–11 M texel-costs, once per session; opts.firstBake = false → spread it like the rest)
      if (!this._firstDone) { this._firstDone = true; if (this.opts.firstBake) this._bakeStep(Infinity, 1); }
      this._bakeStep(this.opts.bakeBudget * (this._seen < 90 || this._fade < 1 ? (this.lo ? 2 : 3) : 1)); // while the screen is busy fading anyway: hurry
    }
    this._dipK = dip;
    U.uAspect.value = camera.aspect || 16 / 9;
    const vh = state.viewH || this.opts.viewH || (typeof window !== 'undefined' ? window.innerHeight * Math.min(window.devicePixelRatio || 1, 2) : 1080);
    U.uPx.value = 2 / Math.max(240, vh);
    this.sky.position.copy(cam);

    // dynamic lights → shared uniform arrays
    const L = state.lights, LP = U.uLP.value, LC = U.uLC.value;
    const nL = L ? Math.min(state.lightCount | 0, MAXL, this._defs.NL) : 0;
    for (let i = 0; i < nL; i++) {
      const o = i * 8, k = i * 4, it = L[o + 7];
      LP[k] = L[o]; LP[k + 1] = L[o + 1]; LP[k + 2] = L[o + 2]; LP[k + 3] = L[o + 6];
      LC[k] = L[o + 3] * it; LC[k + 1] = L[o + 4] * it; LC[k + 2] = L[o + 5] * it;
    }
    U.uLN.value = nL;

    // weather: lightning
    if (this.opts.autoLightning && this._ion > 0.05 && dt > 0) {
      this._boltTimer -= dt * (0.35 + this._ion);
      if (this._boltTimer <= 0) {
        this._boltTimer = 0.7 + this._rand() * 1.9;
        this.lightning((state.playerX ?? 0) + (this._rand() - 0.3) * this._W * 0.9, (this._rand() - 0.5) * this._H * 1.2);
      }
    }
    let flick = 0;
    for (const b of this.bolts) {
      if (!b.on) continue;
      b.age += dt;
      const t = b.age / b.life;
      if (t >= 1) { b.on = false; b.mesh.visible = false; continue; }
      // strike, dim, re-strike
      const l = (t < 0.12 ? 1 : t < 0.3 ? 0.35 : t < 0.42 ? 0.9 : 0.9 * (1 - (t - 0.42) / 0.58)) * (0.8 + 0.2 * Math.sin(b.age * 190));
      b.u.uLife.value = l;
      if (!b.sky && l > flick) flick = l;
    }
    this._flash = Math.max(flick, this._flash * Math.exp(-dt * 7));
    if (this._flash < 0.003) this._flash = 0;
    const fl = this._flash;
    U.uFlashC.value.setRGB(0.22 * fl, 0.36 * fl, 0.7 * fl);
    this.skyU.uSkyFlash.value.setRGB(0.008 * fl, 0.015 * fl, 0.032 * fl);

    // lighting outputs
    const ecl = this._ecl, ion = this._ion;
    this.sunColor.copy(P.keyCol).multiplyScalar((1 - 0.8 * ecl) * (0.35 + 0.65 * dip) * (1 - 0.25 * ion));
    this.sunColor.lerp(this._c.setRGB(0.55, 0.75, 1.2), warp * 0.5);
    this.ambientColor.copy(P.ambCol).multiplyScalar(1 - 0.45 * ecl);
    this.ambientColor.lerp(this._c.setRGB(0.35, 0.6, 1.3), Math.min(1, ion * 0.5 + warp * 0.4));
    this.ambientColor.r += 0.6 * fl; this.ambientColor.g += 0.9 * fl; this.ambientColor.b += 1.5 * fl;

    // sky + stars
    const sU = this.skyU;
    sU.uNebAmt.value = P.nebAmt * dip;
    sU.uSun.value.set(P.sunR, P.sunI, P.sun2R, P.sun2I);
    this.starU.uBright.value = P.starBright * (0.25 + 0.75 * dip) * (1 - 0.35 * ecl) * (1 + warp * 1.4);
    this.starU.uStreak.value = warp * warp * 0.55 + warp * 0.08;

    // fog
    for (const f of this.fog) {
      f.u.uDens.value = f.dens * P.fogDens * (1 + 0.25 * ion) * (0.6 + 0.4 * dip);
      f.mesh.position.x = cam.x + 3200; f.mesh.position.z = cam.z * 0.5;
    }

    // lane
    this.laneU.uLane.value = this._lane;
    this.lane.scale.z = this._H + 1000;

    // dust
    const dU = this.dustU;
    dU.uAnchor.value.set(cam.x + fwdX * 1100, -260, cam.z + fwdZ * 1100);
    dU.uLen.value = 1.5 + (warpMul - 1) * 26 * (0.3 + 0.7 * warp) + (speed - 1) * 2;
    dU.uBright.value = (0.55 + warp * 0.9) * (1 - 0.3 * ecl);

    // planets (lit by a whitened sun: a deep-red star would paint every world the same brown)
    U.uPSunCol.value.copy(P.sunCol).lerp(this._c.setRGB(1, 1, 1), 0.6);
    const pdt = dt * speed, drift = pdt * (1 + (warpMul - 1) * 0.9);
    for (let i = 0; i < this.planets.length; i++) {
      const p = this.planets[i];
      if (!p.on) continue;
      const b = p.body, u = b.u;
      p.pos.x -= p.drift * drift;
      const lim = -(hw + p.R * 2 + 2600 - p.pos.y);
      if (p.pos.x < lim) p.pos.x = 11000 + p.R * 2;
      p.sun.copy(this._sunPos).sub(p.pos).normalize();
      p.spin += p.spinV * pdt;
      p.op = b.surf.ready ? (this._seen < 3 || dip < 0.2 ? 1 : Math.min(1, p.op + dt / 0.6)) : 0;   // ready before anyone looks: no fade-in
      u.uOp.value = dip * p.op;
      this._spinBody(b, p.pos, p.R, p.qTilt, p.spin, p.sun, pdt);
      u.uP2.value.z = p.aur + p.aurBoost;
      if (p.imp >= 0) { p.imp += pdt; if (p.imp > 120) p.imp = -1; u.uImp.value.w = p.imp; }
      if (p.hasHalo) { p.halo.position.copy(p.pos); p.halo.scale.setScalar(p.R * p.haloS); }
      if (p.hasRing) {
        p.ring.position.copy(p.pos); p.ring.scale.setScalar(p.R * p.ringOut * 0.5);
        p.ru.uPC.value.copy(p.pos); p.ru.uPR.value = p.R;
      }
      for (let k = 0; k < p.moons.length; k++) {
        const m = p.moons[k], ms = u.uMoonS.value[k];
        if (!m.on) { ms.w = 0; continue; }
        m.a += m.v * pdt; m.spin += 0.03 * pdt;
        const ca = Math.cos(m.a) * m.D, sa = Math.sin(m.a) * m.D;
        const rel = this._v2.copy(m.e1).multiplyScalar(ca).addScaledVector(m.e2, sa);
        m.pos.copy(p.pos).add(rel);
        // the planet's shadow swallows the moon behind it
        const tt = rel.dot(p.sun);
        let lit = 1;
        if (tt < 0) { const d = this._v3.copy(rel).addScaledVector(p.sun, -tt).length(); lit = smooth(clamp01((d - p.R + m.R * 0.6) / (m.R * 1.6))); }
        const mb = m.body;
        mb.u.uGain.value = m.gain * (0.03 + 0.97 * lit);
        mb.u.uOp.value = mb.surf.ready ? u.uOp.value : 0;
        this._spinBody(mb, m.pos, m.R, this._qI, m.spin, p.sun, pdt);
        ms.set(rel.x / p.R, rel.y / p.R, rel.z / p.R, m.R / p.R);
      }
      p.dist = p.pos.distanceToSquared(cam);
    }
    // far → near, 7 render-order slots per planet
    const ord = this._order;
    for (let i = 1; i < ord.length; i++) { // tiny insertion sort, no allocs
      const x = ord[i]; let j = i - 1;
      while (j >= 0 && ord[j].dist < x.dist) { ord[j + 1] = ord[j]; j--; }
      ord[j + 1] = x;
    }
    for (let i = 0; i < ord.length; i++) {
      const p = ord[i], r = RO.planet + i * 7;
      p.halo.renderOrder = r + 1; p.body.mesh.renderOrder = r + 2; p.ring.renderOrder = r + 3;
      for (let k = 0; k < p.moons.length; k++) { const m = p.moons[k]; m.body.mesh.renderOrder = m.on && m.pos.distanceToSquared(cam) < p.dist ? r + 4 : r; }
    }

    // ambient events (they draw themselves into the blip / instance buffers)
    this.shipU.uKey.value.copy(this._sunPos);
    this._tickEvents(pdt, state);
    this._seen++;

    // comet (two tails: dust lags along the path, ions point straight away from the sun)
    const c = this._comet;
    if (c.on) {
      c.t += pdt / c.dur;
      const p = c.impact;
      if (p) { c.to.copy(p.pos).addScaledVector(c.n, p.R); c.from.copy(c.to).add(c.off); }
      if (c.t >= 1) {
        c.on = false; this.cometMesh.visible = this.cometMesh2.visible = false;
        if (p && p.on) this._strike(p, c.n);
        c.impact = null;
      } else {
        const a = this.cometU.uA.value.copy(c.from).lerp(c.to, c.t);
        const trail = this._v2.copy(c.from).sub(c.to).normalize();
        const anti = this._v3.copy(a).sub(this._sunPos).normalize();
        this.cometU.uB.value.copy(trail).multiplyScalar(0.75).addScaledVector(anti, 0.5).normalize().multiplyScalar(1500).add(a);
        this.comet2U.uA.value.copy(a);
        this.comet2U.uB.value.copy(a).addScaledVector(anti, 2300);
        const hd = this._v2.copy(a).sub(cam).normalize();
        const life = (p ? Math.min(1, c.t * 5) : Math.sin(Math.PI * c.t) ** 0.6) * (1 - 0.5 * ecl) * this._evGain * (1 - 0.8 * this._maskAt(hd.x, hd.y, hd.z));
        this.cometU.uLife.value = life; this.comet2U.uLife.value = life * 0.8;
      }
    }
    if (this._kick > 0.003) {
      const k = this._kick; this._kick *= Math.exp(-dt * 3);
      const sf = this.skyU.uSkyFlash.value; sf.r += 0.02 * k; sf.g += 0.013 * k; sf.b += 0.007 * k;
    }
  }

  // place + orient one sphere, and hand its shader the sun in object space
  _spinBody(b, pos, R, qTilt, spin, sun, pdt) {
    const m = b.mesh, u = b.u;
    m.position.copy(pos); m.scale.setScalar(R);
    m.quaternion.copy(qTilt).multiply(this._q.setFromAxisAngle(this._Y, spin));
    u.uSunO.value.copy(sun).applyQuaternion(this._q2.copy(m.quaternion).invert());
    b.cloudA += b.cloudV * pdt; if (b.cloudA > 6283.1853) b.cloudA -= 6283.1853;
    b.flowT += b.flowV * pdt; if (b.flowT > 1024) b.flowT -= 1024;
    u.uRot.value.x = b.cloudA; u.uP3.value.y = b.flowT;
  }

  // a comet hits planet p at world-space surface normal n
  _strike(p, n) {
    const R = this._rand, ej = this._ej, u = p.body.u;
    const o = this._v3.copy(n).applyQuaternion(this._q2.copy(p.body.mesh.quaternion).invert());
    u.uImp.value.set(o.x, o.y, o.z, 0); p.imp = 0;
    ej.on = true; ej.t = 0; ej.p = p; ej.n.copy(n);
    for (let k = 0; k < 10; k++) {
      const d = this._v2.set(R() - 0.5, R() - 0.5, R() - 0.5).multiplyScalar(1.3).add(n).normalize();
      ej.d[k * 3] = d.x; ej.d[k * 3 + 1] = d.y; ej.d[k * 3 + 2] = d.z; ej.s[k] = 0.3 + R();
    }
    this._kick = 1;
  }
}
