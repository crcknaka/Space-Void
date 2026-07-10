// Image preloader. Only the big background paintings still load from PNG —
// every sprite (ships, bullets, power-ups, explosion, thruster flames) is
// generated procedurally at boot by procassets.js.
const LIST = [
  ['menu_background', 'png'],
];

export const IMG_COUNT = LIST.length;

export async function loadImages(onProgress) {
  const images = {};
  let done = 0;
  await Promise.all(
    LIST.map(([name, ext]) =>
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => { onProgress(++done, LIST.length); resolve(); };
        img.onerror = () => { onProgress(++done, LIST.length); resolve(); };
        img.src = `assets/images/${name}.${ext}`;
        images[name] = img;
      })
    )
  );
  return images;
}
