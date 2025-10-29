const IMAGE_PATH = '../assets/images/';
const SOUND_PATH = '../assets/sounds/';

const IMAGE_ASSETS = {
  player1_img: { file: 'player1_ship.png', size: [50, 30] },
  player1_thruster_frames: {
    files: ['player1_thruster_1.png', 'player1_thruster_2.png', 'player1_thruster_3.png', 'player1_thruster_4.png'],
  },
  player2_img: { file: 'player2_ship.png', size: [50, 30] },
  player2_thruster_frames: {
    files: ['player2_thruster_1.png', 'player2_thruster_2.png', 'player2_thruster_3.png', 'player2_thruster_4.png'],
  },
  enemy_img: { file: 'enemy_ship.png', size: [50, 30] },
  enemy_thruster_frames: {
    files: ['enemy_thruster_1.png', 'enemy_thruster_2.png', 'enemy_thruster_3.png', 'enemy_thruster_4.png'],
  },
  boss_img: { file: 'boss.png', size: [150, 150] },
  bullet_img: { file: 'bullet.png', size: [10, 5] },
  enemy_bullet_img: { file: 'enemy_bullet.png', size: [10, 5] },
  powerup_img: { file: 'powerup.png', size: [60, 30] },
  slow_motion_powerup_img: { file: 'slow_motion_powerup.png', size: [60, 30] },
  kill_all_powerup_img: { file: 'kill_all_powerup.png', size: [60, 30] },
  spread_powerup_img: { file: 'spread_powerup.png', size: [60, 30] },
  rocket_powerup_img: { file: 'rocket_powerup.png', size: [60, 30] },
  menu_background: { file: 'menu_background.png' },
  game_background: { file: 'game_background.png' },
  versus_background: { file: 'versus_background.png' },
  explosion_spritesheet: { file: 'explosion_spritesheet.png' },
  asteroid_img: { file: 'asteroid.png' },
  rocket_img: { file: 'rocket.png', size: [20, 10] },
};

const SOUND_ASSETS = {
  explosion_sound: 'explosion.wav',
  gun_sound: 'gun.wav',
  powerup_sound: 'powerup.wav',
  rocket_sound: 'rocket.wav',
  hover_sound: 'hover.wav',
  click_sound: 'click.wav',
  background_music: 'background_music.mp3',
  versus_music: 'versus_music.mp3',
  player1_kill_sound: 'player1_kill.wav',
  player2_kill_sound: 'player2_kill.wav',
};

function loadImage(src, size) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (size) {
        const [width, height] = size;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0, width, height);
        const scaledImage = new Image();
        scaledImage.onload = () => resolve(scaledImage);
        scaledImage.src = canvas.toDataURL();
      } else {
        resolve(image);
      }
    };
    image.onerror = reject;
    image.src = `${IMAGE_PATH}${src}`;
  });
}

function loadAudio(src) {
  const audio = new Audio(`${SOUND_PATH}${src}`);
  audio.preload = 'auto';
  return audio;
}

export async function loadAssets(updateProgress) {
  const assets = {};
  let loaded = 0;
  const total = Object.keys(IMAGE_ASSETS).length + Object.keys(SOUND_ASSETS).length;

  const increment = () => {
    loaded += 1;
    if (updateProgress) {
      updateProgress(loaded / total);
    }
  };

  const imagePromises = Object.entries(IMAGE_ASSETS).map(async ([key, descriptor]) => {
    if ('files' in descriptor) {
      const frames = await Promise.all(descriptor.files.map((file) => loadImage(file)));
      assets[key] = frames;
    } else {
      assets[key] = await loadImage(descriptor.file, descriptor.size);
    }
    increment();
  });

  await Promise.all(imagePromises);

  Object.entries(SOUND_ASSETS).forEach(([key, file]) => {
    assets[key] = loadAudio(file);
    increment();
  });

  return assets;
}
