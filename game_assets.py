# game_assets.py
import pygame
import os

IMAGE_PATH = 'assets/images/'
SOUND_PATH = 'assets/sounds/'

def load_image(filename, scale=None):
    image = pygame.image.load(os.path.join(IMAGE_PATH, filename)).convert_alpha()
    if scale:
        image = pygame.transform.scale(image, scale)
    return image

def load_sound(filename):
    return pygame.mixer.Sound(os.path.join(SOUND_PATH, filename))

def load_assets():
    assets = {
        'player1_img': load_image('player1_ship.png', (50, 30)),
        'player1_thruster_frames': [load_image(f'player1_thruster_{i}.png') for i in range(1, 5)],
        'player2_img': load_image('player2_ship.png', (50, 30)),
        'player2_thruster_frames': [load_image(f'player2_thruster_{i}.png') for i in range(1, 5)],
        'enemy_img': load_image('enemy_ship.png', (50, 30)),
        'enemy_thruster_frames': [load_image(f'enemy_thruster_{i}.png') for i in range(1, 5)],
        'boss_img': load_image('boss.png', (150, 150)),
        'bullet_img': load_image('bullet.png', (10, 5)),
        'enemy_bullet_img': load_image('enemy_bullet.png', (10, 5)),
        'powerup_img': load_image('powerup.png', (60, 30)),  # Shooting power-up image
        'slow_motion_powerup_img': load_image('slow_motion_powerup.png', (60, 30)),  # Slow-motion power-up image
        'kill_all_powerup_img': load_image('kill_all_powerup.png', (60, 30)),  # Kill-all power-up image
        'spread_powerup_img': load_image('spread_powerup.png', (60, 30)),  # Spread power-up image
        'rocket_powerup_img': load_image('rocket_powerup.png', (60, 30)),  # Rocket power-up image
        'menu_background': load_image('menu_background.png'),
        'game_background': load_image('game_background.png'),  # Game background image
        'versus_background': load_image('versus_background.png'),  # Versus mode background
        'explosion_spritesheet': load_image('explosion_spritesheet.png'),
        'explosion_sound': load_sound('explosion.ogg'),
        'gun_sound': load_sound('gun.ogg'),
        'powerup_sound': load_sound('powerup.ogg'),
        'rocket_sound': load_sound('rocket.ogg'),
        'asteroid_img': load_image('asteroid.png'),  # Asteroid image
        'rocket_img': load_image('rocket.png', (20, 10)),  # Rocket image
        'background_music': 'background_music.ogg',  # Background music file
        'versus_music': 'versus_music.ogg',  # Versus mode music
        'player1_kill_sound': load_sound('player1_kill.ogg'),
        'player2_kill_sound': load_sound('player2_kill.ogg'),
        
    }
    return assets
