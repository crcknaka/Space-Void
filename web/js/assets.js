// Image preloader (mirrors game_assets.py)
const LIST = [
  ['player1_ship', 'png'], ['player2_ship', 'png'], ['enemy_ship', 'png'], ['boss', 'png'],
  ['bullet', 'png'], ['enemy_bullet', 'png'], ['rocket', 'png'], ['asteroid', 'png'],
  ['powerup', 'png'], ['slow_motion_powerup', 'png'], ['kill_all_powerup', 'png'],
  ['spread_powerup', 'png'], ['rocket_powerup', 'png'],
  ['explosion_spritesheet', 'png'],
  ['menu_background', 'png'], ['game_background', 'png'], ['versus_background', 'png'],
  ['player1_thruster_1', 'png'], ['player1_thruster_2', 'png'], ['player1_thruster_3', 'png'], ['player1_thruster_4', 'png'],
  ['player2_thruster_1', 'png'], ['player2_thruster_2', 'png'], ['player2_thruster_3', 'png'], ['player2_thruster_4', 'png'],
  ['enemy_thruster_1', 'png'], ['enemy_thruster_2', 'png'], ['enemy_thruster_3', 'png'], ['enemy_thruster_4', 'png'],
];

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
  images.thrusters = {
    player1: [1, 2, 3, 4].map((i) => images[`player1_thruster_${i}`]),
    player2: [1, 2, 3, 4].map((i) => images[`player2_thruster_${i}`]),
    enemy: [1, 2, 3, 4].map((i) => images[`enemy_thruster_${i}`]),
  };
  return images;
}
