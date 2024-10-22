# game_classes.py

import pygame
import random
import math
from settings import WIDTH, HEIGHT  # Import screen dimensions from settings

game_speed_multiplier = 1.0

def set_game_speed_multiplier(value):
    global game_speed_multiplier
    game_speed_multiplier = value

class Player(pygame.sprite.Sprite):
    def __init__(self, image, thruster_frames, bullets_group, rockets_group, all_sprites_group, targets_group, assets, controls, facing_left=False):
        super().__init__()
        self.assets = assets
        self.original_image = image  # Reference to the original ship image
        self.image = self.original_image.copy()
        self.rect = self.image.get_rect()
        self.rect.centerx = 100
        self.rect.centery = HEIGHT // 2
        self.bullets_group = bullets_group
        self.rockets_group = rockets_group
        self.all_sprites_group = all_sprites_group
        self.targets_group = targets_group
        self.shoot_delay = 500  # Default shoot delay in milliseconds
        self.last_shot = pygame.time.get_ticks()
        self.paused = False
        self.powered_up = False
        self.powerup_end_time = 0
        self.rocket_count = 3  # Starting number of rockets
        self.default_speed = 5  # Default movement speed
        self.fast_speed = 8  # Speed when speed key is pressed

        # Thruster animation attributes
        self.thruster_frames = thruster_frames
        self.current_thruster_frame = 0
        self.last_thruster_update = pygame.time.get_ticks()
        self.thruster_frame_rate = 50  # Milliseconds between thruster frames

        # Controls
        self.controls = controls
        self.alive = True  # Player's alive status
        self.facing_left = facing_left
        self.bullet_speedx = -10 if self.facing_left else 10
        self.last_rocket = pygame.time.get_ticks()
        self.rocket_delay = 700  # Delay between rocket launches in milliseconds

        # Track the number of bullets to shoot with spread power-up
        self.spread_bullet_count = 1  # Starts with 1, increased by power-ups

    def update(self):
        if self.paused or not self.alive:
            return

        self.speedx = 0
        self.speedy = 0
        keys = pygame.key.get_pressed()

        # Check if speed key is pressed to adjust the speed
        if keys[self.controls['speed']]:
            current_speed = self.fast_speed
        else:
            current_speed = self.default_speed

        if keys[self.controls['up']]:
            self.speedy = -current_speed
        if keys[self.controls['down']]:
            self.speedy = current_speed
        if keys[self.controls['left']]:
            self.speedx = -current_speed
        if keys[self.controls['right']]:
            self.speedx = current_speed

        self.rect.x += self.speedx * game_speed_multiplier
        self.rect.y += self.speedy * game_speed_multiplier

        # Keep the player on the screen
        if self.rect.top < 0:
            self.rect.top = 0
        if self.rect.bottom > HEIGHT:
            self.rect.bottom = HEIGHT
        if self.rect.left < 0:
            self.rect.left = 0
        if self.rect.right > WIDTH:
            self.rect.right = WIDTH

        # Automatic shooting
        if self.bullets_group is not None:
            self.shoot()

        # Handle rocket firing when rocket key is pressed
        if 'rocket' in self.controls:
            keys = pygame.key.get_pressed()
            if keys[self.controls['rocket']]:
                self.handle_rocket()

        self.update_thruster()

        # Check if power-up effect has ended
        if self.powered_up and pygame.time.get_ticks() > self.powerup_end_time:
            self.shoot_delay = 500  # Reset to default
            self.powered_up = False

    def update_thruster(self):
        now = pygame.time.get_ticks()
        if now - self.last_thruster_update > self.thruster_frame_rate:
            self.last_thruster_update = now
            self.current_thruster_frame = (self.current_thruster_frame + 1) % len(self.thruster_frames)

        # Get the current thruster frame
        thruster_frame = self.thruster_frames[self.current_thruster_frame]
        # Create a new surface to hold both the ship and thruster
        if self.facing_left:
            # Flip the thruster frame horizontally for facing left
            thruster_frame = pygame.transform.flip(thruster_frame, True, False)
            total_width = self.original_image.get_width() + thruster_frame.get_width()
            total_height = max(self.original_image.get_height(), thruster_frame.get_height())
            new_image = pygame.Surface((total_width, total_height), pygame.SRCALPHA)
            # Blit the ship onto the new image
            ship_rect = self.original_image.get_rect()
            ship_rect.left = 0  # Ship on the left
            ship_rect.centery = total_height // 2
            new_image.blit(self.original_image, ship_rect)
            # Blit the thruster onto the new image
            thruster_rect = thruster_frame.get_rect()
            thruster_rect.left = self.original_image.get_width()  # Thruster to the right of ship
            thruster_rect.centery = total_height // 2
            new_image.blit(thruster_frame, thruster_rect)
        else:
            total_width = self.original_image.get_width() + thruster_frame.get_width()
            total_height = max(self.original_image.get_height(), thruster_frame.get_height())
            new_image = pygame.Surface((total_width, total_height), pygame.SRCALPHA)
            # Blit the thruster onto the new image
            thruster_rect = thruster_frame.get_rect()
            thruster_rect.left = 0  # Thruster on the left
            thruster_rect.centery = total_height // 2
            new_image.blit(thruster_frame, thruster_rect)
            # Blit the ship onto the new image
            ship_rect = self.original_image.get_rect()
            ship_rect.left = thruster_frame.get_width()  # Ship to the right of thruster
            ship_rect.centery = total_height // 2
            new_image.blit(self.original_image, ship_rect)
        # Update image and rect
        self.image = new_image
        # Preserve the center position
        old_center = self.rect.center
        self.rect = self.image.get_rect()
        self.rect.center = old_center

    def shoot(self):
        now = pygame.time.get_ticks()
        if now - self.last_shot > self.shoot_delay:
            if self.facing_left:
                bullet_img = pygame.transform.flip(self.assets['bullet_img'], True, False)
                # Fire multiple bullets with spread
                spread_angle = 10  # Angle between each bullet
                start_angle = -(self.spread_bullet_count - 1) * (spread_angle / 2)
                for i in range(self.spread_bullet_count):
                    angle = start_angle + (i * spread_angle)
                    bullet = Bullet(self.rect.left, self.rect.centery, bullet_img, speedx=-10, angle=angle)
                    self.bullets_group.add(bullet)
                    self.all_sprites_group.add(bullet)
            else:
                spread_angle = 10
                start_angle = -(self.spread_bullet_count - 1) * (spread_angle / 2)
                for i in range(self.spread_bullet_count):
                    angle = start_angle + (i * spread_angle)
                    bullet = Bullet(self.rect.right, self.rect.centery, self.assets['bullet_img'], speedx=10, angle=angle)
                    self.bullets_group.add(bullet)
                    self.all_sprites_group.add(bullet)
            
            self.last_shot = now
            self.assets['gun_sound'].play()
            
    def increase_spread(self):
        """Increase the number of bullets fired in a spread."""
        self.spread_bullet_count += 1        

    def handle_rocket(self):
        if self.rockets_group is None or self.targets_group is None:
            return  # Rockets not used

        now = pygame.time.get_ticks()
        if self.rocket_count > 0 and now - self.last_rocket > self.rocket_delay:
            rocket = Rocket(self.rect.centerx, self.rect.centery, self.assets['rocket_img'], self.targets_group, self.assets, self.all_sprites_group)
            self.rockets_group.add(rocket)
            self.all_sprites_group.add(rocket)
            self.last_rocket = now
            self.rocket_count -= 1
            self.assets['rocket_sound'].play()

    def pause(self):
        self.paused = not self.paused

    def power_up(self):
        self.shoot_delay = 200  # Faster shooting
        self.powered_up = True
        self.powerup_end_time = pygame.time.get_ticks() + 5000  # Effect lasts 5 seconds

    def add_rockets(self, amount):
        self.rocket_count += amount


class Bullet(pygame.sprite.Sprite):
    def __init__(self, x, y, image, speedx=10, angle=0):
        super().__init__()
        self.image = image
        self.rect = self.image.get_rect()
        if speedx > 0:
            self.rect.left = x
        else:
            self.rect.right = x
        self.rect.centery = y
        self.speedx = speedx
        self.angle = angle  # Angle for the spread effect
        self.speedy = speedx * math.tan(math.radians(angle))  # Calculate vertical speed based on the angle
        self.paused = False

    def update(self):
        if self.paused:
            return

        # Update bullet position based on angle and speed
        self.rect.x += self.speedx  # Bullets not affected by game_speed_multiplier
        self.rect.y += self.speedy
        if self.rect.left > WIDTH or self.rect.right < 0:
            self.kill()

    def pause(self):
        self.paused = not self.paused


class Rocket(pygame.sprite.Sprite):
    def __init__(self, x, y, image, targets_group, assets, all_sprites_group):
        super().__init__()
        self.original_image = image
        self.image = self.original_image.copy()
        self.rect = self.image.get_rect()
        self.rect.centerx = x
        self.rect.centery = y
        self.speed = 8
        self.rotation_speed = 2  # Controls how fast the rocket rotates
        self.angle = 0  # Initial angle
        self.targets_group = targets_group
        self.assets = assets
        self.paused = False
        self.all_sprites_group = all_sprites_group  # Reference to all_sprites_group

    def find_nearest_target(self):
        # Find the nearest target (enemy or asteroid)
        nearest_target = None
        min_distance = float('inf')
        for sprite in self.targets_group.sprites():
            distance = math.hypot(
                self.rect.centerx - sprite.rect.centerx,
                self.rect.centery - sprite.rect.centery,
            )
            if distance < min_distance:
                min_distance = distance
                nearest_target = sprite
        return nearest_target

    def update(self):
        if self.paused:
            return

        # Always find the nearest target every frame
        self.target = self.find_nearest_target()

        if self.target:
            # Calculate direction towards the target
            dx = self.target.rect.centerx - self.rect.centerx
            dy = self.target.rect.centery - self.rect.centery
            angle_to_target = math.atan2(dy, dx)

            # Smoothly rotate towards the target angle
            target_angle = math.degrees(angle_to_target)
            angle_diff = (target_angle - self.angle) % 360
            if angle_diff > 180:
                angle_diff -= 360

            # Smoothly rotate towards the target
            self.angle += min(self.rotation_speed, max(-self.rotation_speed, angle_diff))
            self.angle %= 360

            # Move the rocket towards the target using the calculated angle
            rad_angle = math.radians(self.angle)
            self.rect.x += self.speed * math.cos(rad_angle)
            self.rect.y += self.speed * math.sin(rad_angle)

            # Update the rocket's image with smooth rotation
            self.image = pygame.transform.rotate(self.original_image, -self.angle)
            self.rect = self.image.get_rect(center=self.rect.center)
        else:
            # If no target, move straight in the current direction
            rad_angle = math.radians(self.angle)
            self.rect.x += self.speed * math.cos(rad_angle)
            self.rect.y += self.speed * math.sin(rad_angle)

        # Emit trail particles
        trail_particle = RocketTrailParticle(self.rect.centerx, self.rect.centery)
        self.all_sprites_group.add(trail_particle)

        # Destroy the rocket if it goes off the screen
        if (self.rect.right < 0 or self.rect.left > WIDTH or
                self.rect.bottom < 0 or self.rect.top > HEIGHT):
            self.kill()

    def pause(self):
        self.paused = not self.paused


class RocketTrailParticle(pygame.sprite.Sprite):
    def __init__(self, x, y):
        super().__init__()
        # Randomize particle properties
        self.size = random.randint(2, 4)  # Size of the particle
        self.color = (255, 165, 0, 150)  # Orange color with some transparency
        self.image = pygame.Surface((self.size*2, self.size*2), pygame.SRCALPHA)
        pygame.draw.circle(self.image, self.color, (self.size, self.size), self.size)
        self.rect = self.image.get_rect(center=(x, y))
        self.speedx = random.uniform(-1, 1)
        self.speedy = random.uniform(-1, 1)
        self.lifetime = 500  # Lifetime in milliseconds
        self.spawn_time = pygame.time.get_ticks()
        self.fade_rate = 150 / self.lifetime  # Alpha decrement per millisecond

    def update(self):
        current_time = pygame.time.get_ticks()
        elapsed_time = current_time - self.spawn_time

        if elapsed_time > self.lifetime:
            self.kill()
            return

        # Move the particle
        self.rect.x += self.speedx
        self.rect.y += self.speedy

        # Fade out
        alpha = max(0, self.color[3] - (elapsed_time * self.fade_rate))
        self.image.set_alpha(alpha)

    def pause(self):
        # Optional: Implement pause functionality if needed
        pass


class Enemy(pygame.sprite.Sprite):
    def __init__(self, image, enemy_bullets_group, all_sprites_group, assets, move_randomly=False, level=1):
        super().__init__()
        self.assets = assets
        self.original_image = image  # Reference to the original enemy ship image
        self.image = self.original_image.copy()
        self.rect = self.image.get_rect()
        self.rect.x = WIDTH + random.randint(50, 100)
        self.rect.y = random.randint(0, HEIGHT - self.rect.height)
        self.speedx = random.randint(-3, -1) - (level - 1)  # Increase speed with level
        self.speedy = 0
        self.enemy_bullets_group = enemy_bullets_group
        self.all_sprites_group = all_sprites_group
        self.shoot_delay = random.randint(1500, 3000) - (level - 1) * 100  # Faster shooting with level
        self.last_shot = pygame.time.get_ticks()
        self.paused = False
        self.move_randomly = move_randomly
        if self.move_randomly:
            self.speedy = random.choice([-2, -1, 0, 1, 2])
        # Thruster animation attributes
        self.thruster_frames = assets['enemy_thruster_frames']
        self.current_thruster_frame = 0
        self.last_thruster_update = pygame.time.get_ticks()
        self.thruster_frame_rate = 50  # Milliseconds between thruster frames

    def update(self):
        if self.paused:
            return

        self.rect.x += self.speedx * game_speed_multiplier
        self.rect.y += self.speedy * game_speed_multiplier

        # Keep the enemy within vertical bounds
        if self.rect.top < 0 or self.rect.bottom > HEIGHT:
            self.speedy *= -1  # Reverse direction if hitting top or bottom

        # Remove enemy if it goes off-screen to the left
        if self.rect.right < 0:
            self.kill()

        self.shoot()
        self.update_thruster()

    def update_thruster(self):
        now = pygame.time.get_ticks()
        if now - self.last_thruster_update > self.thruster_frame_rate:
            self.last_thruster_update = now
            self.current_thruster_frame = (self.current_thruster_frame + 1) % len(self.thruster_frames)

        # Get the current thruster frame
        thruster_frame = self.thruster_frames[self.current_thruster_frame]
        # Flip the thruster frame horizontally for the enemy
        thruster_frame = pygame.transform.flip(thruster_frame, True, False)
        # Create a new surface to hold both the ship and thruster
        total_width = self.original_image.get_width() + thruster_frame.get_width()
        total_height = max(self.original_image.get_height(), thruster_frame.get_height())
        new_image = pygame.Surface((total_width, total_height), pygame.SRCALPHA)
        # Blit the ship onto the new image
        ship_rect = self.original_image.get_rect()
        ship_rect.left = 0  # Ship on the left
        ship_rect.centery = total_height // 2
        new_image.blit(self.original_image, ship_rect)
        # Blit the thruster onto the new image
        thruster_rect = thruster_frame.get_rect()
        thruster_rect.left = self.original_image.get_width()  # Thruster to the right of ship
        thruster_rect.centery = total_height // 2
        new_image.blit(thruster_frame, thruster_rect)
        # Update image and rect
        self.image = new_image
        # Preserve the center position
        old_center = self.rect.center
        self.rect = self.image.get_rect()
        self.rect.center = old_center

    def shoot(self):
        now = pygame.time.get_ticks()
        if now - self.last_shot > self.shoot_delay:
            bullet = EnemyBullet(self.rect.left, self.rect.centery, self.assets['enemy_bullet_img'])
            self.enemy_bullets_group.add(bullet)
            self.all_sprites_group.add(bullet)  # Add enemy bullet to all_sprites
            self.last_shot = now

    def pause(self):
        self.paused = not self.paused


class EnemyBullet(pygame.sprite.Sprite):
    def __init__(self, x, y, image, speedx=-8, speedy=0):
        super().__init__()
        self.image = image
        self.rect = self.image.get_rect()
        self.rect.centerx = x
        self.rect.centery = y
        self.speedx = speedx
        self.speedy = speedy
        self.paused = False

    def update(self):
        if self.paused:
            return

        self.rect.x += self.speedx  # Bullets not affected by game_speed_multiplier
        self.rect.y += self.speedy
        if (self.rect.right < 0 or self.rect.left > WIDTH or
                self.rect.bottom < 0 or self.rect.top > HEIGHT):
            self.kill()

    def pause(self):
        self.paused = not self.paused


class Boss(pygame.sprite.Sprite):
    def __init__(self, image, enemy_bullets_group, all_sprites_group, assets, level=1):
        super().__init__()
        self.assets = assets
        self.image = image
        self.rect = self.image.get_rect()
        self.rect.x = WIDTH
        self.rect.y = HEIGHT // 2 - self.rect.height // 2
        self.speedx = -1 - (level - 1) * 0.5  # Increase speed with level
        self.enemy_bullets_group = enemy_bullets_group
        self.all_sprites_group = all_sprites_group
        self.shoot_delay = max(500, 1000 - (level - 1) * 100)  # Increase shooting rate with level
        self.last_shot = pygame.time.get_ticks()
        self.paused = False
        # Adjust health so that at level 1, boss has lower health
        self.health = 5 + (level - 1) * 5  # Health increases with level

    def update(self):
        if self.paused:
            return

        self.rect.x += self.speedx * game_speed_multiplier
        if self.rect.right <= WIDTH - 150:
            self.speedx = 0  # Boss stops moving horizontally after reaching position
        self.shoot()

    def shoot(self):
        now = pygame.time.get_ticks()
        if now - self.last_shot > self.shoot_delay:
            # Boss fires bullets in multiple directions
            bullet_angles = [-60, -45, -30, -15, 0, 15, 30, 45, 60]
            for angle in bullet_angles:
                rad = math.radians(angle)
                speedx = -8 * math.cos(rad)
                speedy = -8 * math.sin(rad)
                bullet = EnemyBullet(self.rect.centerx, self.rect.centery, self.assets['enemy_bullet_img'], speedx, speedy)
                self.enemy_bullets_group.add(bullet)
                self.all_sprites_group.add(bullet)
            self.last_shot = now

    def take_damage(self, amount):
        self.health -= amount
        if self.health <= 0:
            self.kill()

    def pause(self):
        self.paused = not self.paused


class Asteroid(pygame.sprite.Sprite):
    def __init__(self, image, size='large'):
        super().__init__()
        self.original_image = image
        self.size = size
        self.angle = 0

        # Set different rotation speeds for different sizes
        if self.size == 'large':
            self.rotation_speed = random.uniform(0.5, 1)
        elif self.size == 'medium':
            self.rotation_speed = random.uniform(1, 2)  # Faster for medium
        elif self.size == 'small':
            self.rotation_speed = random.uniform(2, 3)  # Even faster for small

        # Scale the asteroid image based on its size (only once during creation)
        self.image = self.get_scaled_image()
        self.original_image = self.image  # Store the scaled image for rotation

        # Set different movement speeds for different sizes
        if self.size == 'large':
            self.speedx = random.uniform(1, 2)  # Slow horizontal speed for large asteroids
            self.speedy = random.uniform(-1, 1)  # Small vertical movement range
        elif self.size == 'medium':
            self.speedx = random.uniform(2, 4)  # Medium speed for medium asteroids
            self.speedy = random.uniform(-2, 2)
        elif self.size == 'small':
            self.speedx = random.uniform(4, 6)  # Fast horizontal speed for small asteroids
            self.speedy = random.uniform(-3, 3)

        self.rect = self.image.get_rect()
        self.rect.x = WIDTH + random.randint(5, 10)
        self.rect.y = random.randint(0, HEIGHT - self.rect.height)
        self.last_update = pygame.time.get_ticks()
        self.rotation_delay = 50  # Rotate every 50 milliseconds

    def get_scaled_image(self):
        """Return the scaled asteroid image based on its size."""
        if self.size == 'large':
            random_size = random.randint(80, 150)  # Random size between 80 and 150 for large asteroids
            return pygame.transform.scale(self.original_image, (random_size, random_size))  # Random large asteroid size
        elif self.size == 'medium':
            random_size = random.randint(40, 80)  # Random size between 40 and 80 for medium asteroids
            return pygame.transform.scale(self.original_image, (random_size, random_size))  # Random medium asteroid size
        elif self.size == 'small':
            random_size = random.randint(20, 40)  # Random size between 20 and 40 for small asteroids
            return pygame.transform.scale(self.original_image, (random_size, random_size))  # Random small asteroid size

    def update(self):
        # Update rotation for all asteroid sizes
        now = pygame.time.get_ticks()
        if now - self.last_update > self.rotation_delay:
            self.last_update = now
            self.angle += self.rotation_speed * game_speed_multiplier
            self.image = pygame.transform.rotate(self.original_image, self.angle)  # Rotate scaled image
            self.rect = self.image.get_rect(center=self.rect.center)

        # Update position
        self.rect.x -= self.speedx * game_speed_multiplier
        self.rect.y += self.speedy * game_speed_multiplier
        if self.rect.right < 0 or self.rect.top > HEIGHT or self.rect.bottom < 0:
            self.kill()

    def break_apart(self):
        pieces = []
        next_size = {'large': 'medium', 'medium': 'small', 'small': None}
        new_size = next_size[self.size]

        # Number of pieces for medium asteroids: 2-3 small asteroids
        if self.size == 'medium':
            piece_count = random.randint(2, 3)
        else:
            piece_count = 2 if self.size == 'large' else 1  # Reduce count for medium asteroids

        if new_size:
            for _ in range(piece_count):
                asteroid = Asteroid(self.original_image, new_size)
                asteroid.rect.center = self.rect.center
                asteroid.speedx = random.uniform(-3, 3)
                asteroid.speedy = random.uniform(-3, 3)
                pieces.append(asteroid)
        return pieces


class PowerUp(pygame.sprite.Sprite):
    def __init__(self, image, powerup_type):
        super().__init__()
        self.image = image
        self.rect = self.image.get_rect()
        self.rect.x = WIDTH + random.randint(50, 100)
        self.rect.y = random.randint(0, HEIGHT - self.rect.height)
        self.speedx = -3
        self.paused = False
        self.type = powerup_type  # Type of power-up

    def update(self):
        if self.paused:
            return

        self.rect.x += self.speedx * game_speed_multiplier
        if self.rect.right < 0:
            self.kill()

    def pause(self):
        self.paused = not self.paused


class Explosion(pygame.sprite.Sprite):
    def __init__(self, center, spritesheet):
        super().__init__()
        self.spritesheet = spritesheet
        self.frames = []
        self.load_frames()
        self.image = self.frames[0]
        self.rect = self.image.get_rect()
        self.rect.center = center
        self.frame_index = 0
        self.last_update = pygame.time.get_ticks()
        self.frame_rate = 50  # Milliseconds between frames

    def load_frames(self):
        sheet_width = self.spritesheet.get_width()
        sheet_height = self.spritesheet.get_height()
        columns = 5
        rows = 1
        frame_width = sheet_width // columns
        frame_height = sheet_height // rows

        for row in range(rows):
            for col in range(columns):
                frame = self.spritesheet.subsurface(
                    pygame.Rect(
                        col * frame_width,
                        row * frame_height,
                        frame_width,
                        frame_height
                    )
                )
                self.frames.append(frame)

    def update(self):
        now = pygame.time.get_ticks()
        if now - self.last_update > self.frame_rate:
            self.last_update = now
            self.frame_index += 1
            if self.frame_index >= len(self.frames):
                self.kill()
            else:
                center = self.rect.center
                self.image = self.frames[self.frame_index]
                self.rect = self.image.get_rect()
                self.rect.center = center


class Star:
    def __init__(self, x, y, speed, size, opacity):
        self.x = x
        self.y = y
        self.speed = speed
        self.size = size
        self.opacity = opacity

    def update(self):
        self.x -= self.speed * game_speed_multiplier
        if self.x < 0:
            self.x = WIDTH
            self.y = random.randint(0, HEIGHT)

    def draw(self, surface):
        star_surface = pygame.Surface((self.size * 2, self.size * 2), pygame.SRCALPHA)
        pygame.draw.circle(
            star_surface,
            (255, 255, 255, self.opacity),
            (self.size, self.size),
            self.size,
        )
        surface.blit(star_surface, (int(self.x), int(self.y)))

