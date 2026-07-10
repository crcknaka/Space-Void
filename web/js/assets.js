// Image preloader. Every visual — sprites AND backgrounds — is generated
// procedurally at boot now (procassets.js / bggen.js); nothing loads from PNG.
const LIST = [];

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
