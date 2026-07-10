// shipgen_page.js — dev gallery (?shipgen) for the procedural ship generator.
// Grid of baked sprites by family; click a cell to inspect it live-rendered
// (turntable spin + bank wobble — the animation ships get in game).
// R rerolls all seeds; in inspect mode ←/→ steps the seed, ↑/↓ the family.
import { W, H } from './const.js';
import * as input from './input.js';
import { drawText } from './ui.js';
import { renderMesh, fitTransform, bakeAuto, VIEW } from './mesh3d.js';
import { genShip } from './shipgen.js';
import { bossStaticMesh } from './bossgen.js';

const FAMS = ['player', 'basic', 'weaver', 'hunter', 'tank', 'boss'];
// boss row shows the real in-game bosses: seed = level
const buildMesh = (fam, seed) => (fam === 'boss' ? bossStaticMesh(seed) : genShip(seed, fam));

export class ShipGenState {
  constructor(app) {
    this.app = app;
    this.baseSeed = 1;
    this.t = 0;
    this.focus = null; // { fam, seed, mesh, fit }
    this.rebuild();
    // debug deep-link: ?shipgen&focus=player:7&a=1.5 opens the inspector
    // statically (a = fixed turntable angle in radians)
    const q = new URLSearchParams(location.search);
    const fp = q.get('focus');
    if (fp) {
      const [fam, s] = fp.split(':');
      this.noSpin = true;
      this.fixedA = Number(q.get('a')) || 0;
      this.setFocus(fam, Number(s) || 1);
    }
  }

  rebuild() {
    this.header = 64;
    this.rowH = Math.floor((H - this.header - 16) / FAMS.length);
    const cs = this.rowH - 14;
    this.cols = Math.max(3, Math.min(9, Math.floor((W - 90) / (cs + 12))));
    this.cellW = cs;
    this.grid = FAMS.map((fam, row) => {
      const cells = [];
      for (let col = 0; col < this.cols; col++) {
        const seed = fam === 'boss' ? col + 1 : this.baseSeed + row * 1009 + col; // boss row = levels 1..N
        cells.push({
          fam, seed,
          x: 78 + col * (cs + 12),
          y: this.header + row * this.rowH + 7,
          sprite: bakeAuto(buildMesh(fam, seed), cs * 2, cs * 2), // 2x for HiDPI
        });
      }
      return cells;
    });
  }

  onResize() { this.rebuild(); }

  setFocus(fam, seed) {
    const mesh = buildMesh(fam, seed);
    const s = Math.min(W, H) * 0.62;
    this.focus = {
      fam, seed, mesh, box: s,
      fit: fitTransform(mesh, s, s, VIEW, 0.7),
      sprite: bakeAuto(mesh, 360, 360), // baked twin for live-vs-bake comparison
    };
  }

  update(dt) {
    this.t += dt;
    const pr = input.pressed;
    if (this.focus) {
      const f = this.focus;
      if (pr.has('Escape') || input.pointer.justDown) { this.focus = null; return; }
      if (pr.has('ArrowRight')) this.setFocus(f.fam, f.seed + 1);
      if (pr.has('ArrowLeft')) this.setFocus(f.fam, f.seed - 1);
      if (pr.has('ArrowDown')) this.setFocus(FAMS[(FAMS.indexOf(f.fam) + 1) % FAMS.length], f.seed);
      if (pr.has('ArrowUp')) this.setFocus(FAMS[(FAMS.indexOf(f.fam) + FAMS.length - 1) % FAMS.length], f.seed);
      return;
    }
    if (pr.has('KeyR')) {
      this.baseSeed = (Math.random() * 1e9) | 0;
      this.rebuild();
    }
    if (input.pointer.justDown) {
      for (const row of this.grid) {
        for (const c of row) {
          if (input.pointer.x >= c.x && input.pointer.x <= c.x + this.cellW &&
              input.pointer.y >= c.y && input.pointer.y <= c.y + this.cellW) {
            this.setFocus(c.fam, c.seed);
            return;
          }
        }
      }
    }
  }

  draw(g) {
    g.fillStyle = '#06080d';
    g.fillRect(0, 0, W, H);
    drawText(g, 'SHIP GENERATOR', W / 2, 26, 26, 'rgb(120,220,255)');
    drawText(g, 'click: inspect · R: reroll seeds', W / 2, 50, 14, 'rgba(255,255,255,0.55)');

    for (let row = 0; row < this.grid.length; row++) {
      const cells = this.grid[row];
      const cy = this.header + row * this.rowH + this.rowH / 2;
      g.save();
      g.translate(26, cy);
      g.rotate(-Math.PI / 2);
      drawText(g, FAMS[row].toUpperCase(), 0, 0, 13, 'rgba(255,255,255,0.5)');
      g.restore();
      for (const c of cells) {
        g.fillStyle = 'rgba(255,255,255,0.04)';
        g.strokeStyle = 'rgba(255,255,255,0.09)';
        g.lineWidth = 1;
        g.fillRect(c.x, c.y, this.cellW, this.cellW);
        g.strokeRect(c.x, c.y, this.cellW, this.cellW);
        g.drawImage(c.sprite, c.x, c.y, this.cellW, this.cellW);
      }
    }

    if (this.focus) {
      const f = this.focus;
      g.fillStyle = 'rgba(0,0,0,0.82)';
      g.fillRect(0, 0, W, H);
      const spin = this.noSpin ? (this.fixedA || 0) : this.t * 0.0009;
      const bank = this.noSpin ? 0 : 0.16 * Math.sin(this.t / 900);
      renderMesh(g, f.mesh, {
        ...f.fit,
        x: W / 2 - f.box / 2 + f.fit.x,
        y: H / 2 - f.box / 2 + f.fit.y,
        rx: VIEW.rx + bank,
        ry: VIEW.ry + spin,
        rz: VIEW.rz,
      });
      if (this.noSpin) { // debug deep-link: baked twin for live-vs-bake comparison
        g.drawImage(f.sprite, 14, H - 194, 180, 180);
        g.strokeStyle = 'rgba(255,255,255,0.2)';
        g.strokeRect(14, H - 194, 180, 180);
        drawText(g, 'baked', 104, H - 200, 12, 'rgba(255,255,255,0.5)');
      }
      drawText(g, `${f.fam.toUpperCase()} · seed ${f.seed}`, W / 2, H / 2 + f.box / 2 + 30, 20, 'rgb(120,220,255)');
      drawText(g, '←/→ seed · ↑/↓ family · ESC close', W / 2, H / 2 + f.box / 2 + 56, 14, 'rgba(255,255,255,0.55)');
    }
  }
}
