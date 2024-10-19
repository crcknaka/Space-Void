# game.py
import pygame
import random
import sys
from game_classes import (
    Player,
    Enemy,
    Boss,
    Explosion,
    Star,
    PowerUp,
    Asteroid,
    set_game_speed_multiplier,
)
from game_assets import load_assets
from menu import main_menu
from settings import WIDTH, HEIGHT  # Import screen dimensions from settings
from main import screen
hover_sound = pygame.mixer.Sound('assets/sounds/hover.wav')  # Add your hover sound file
click_sound = pygame.mixer.Sound('assets/sounds/click.wav')  # Add your click sound file
# Colors
WHITE = (255, 255, 255)
BLACK = (0, 0, 0)
RED = (255, 0, 0)

assets = load_assets()

def main():

    pygame.mixer.music.load('assets/sounds/background_music.mp3')
    pygame.mixer.music.play(-1)  # Loop the music indefinitely
# Fonts
game_font = pygame.font.Font(None, 36)  # Default font
game_over_font = pygame.font.Font(None, 72)

def game_loop(cooperative=False):
    global score
    score = 0
    level = 1
    next_boss_score = 100  # Score needed to spawn the next boss
    boss_spawned = False  # Flag to check if boss has been spawned
    paused = False

    game_speed_multiplier = 1.0
    slow_motion_end_time = None

    all_sprites = pygame.sprite.Group()
    bullets = pygame.sprite.Group()
    rockets = pygame.sprite.Group()
    enemy_bullets = pygame.sprite.Group()
    enemies = pygame.sprite.Group()
    asteroids = pygame.sprite.Group()
    powerups = pygame.sprite.Group()

    # Create multiple layers of stars for parallax effect
    star_layers = []
    for i in range(3):
        star_layer = [
            Star(
                random.randint(0, WIDTH),
                random.randint(0, HEIGHT),
                random.uniform(0.1 * (i + 1), 1.1 * (i + 1)),
                random.randint(1, 2),
                random.randint(30, 100),
            )
            for _ in range(50)
        ]
        star_layers.append(star_layer)

    # Combine enemies and asteroids for rockets to target
    combined_targets = pygame.sprite.Group()

    # Define controls for both players
    player1_controls = {
        'up': pygame.K_w,
        'down': pygame.K_s,
        'left': pygame.K_a,
        'right': pygame.K_d,
        'rocket': pygame.K_SPACE,
        'speed': pygame.K_LSHIFT,
    }

    player2_controls = {
        'up': pygame.K_UP,
        'down': pygame.K_DOWN,
        'left': pygame.K_LEFT,
        'right': pygame.K_RIGHT,
        'rocket': pygame.K_RETURN,
        'speed': pygame.K_KP0,  # Numpad 0
    }

    player1 = Player(
        assets['player1_img'],
        assets['player1_thruster_frames'],
        bullets,
        rockets,
        all_sprites,
        combined_targets,
        assets,
        player1_controls,
    )
    player1.rect.centerx = 100
    player1.rect.centery = HEIGHT // 2

    all_sprites.add(player1)

    if cooperative:
        player2 = Player(
            assets['player2_img'],
            assets['player2_thruster_frames'],
            bullets,
            rockets,
            all_sprites,
            combined_targets,
            assets,
            player2_controls,
        )
        player2.rect.centerx = 100
        player2.rect.centery = HEIGHT // 3

        all_sprites.add(player2)
    else:
        player2 = None  # No player 2 in single-player mode

    ADDENEMY = pygame.USEREVENT + 1
    ADDPOWERUP = pygame.USEREVENT + 2
    ADDASTEROID = pygame.USEREVENT + 3

    enemy_spawn_interval = 2000  # Initial spawn interval for enemies
    asteroid_spawn_interval = 5000  # Initial spawn interval for asteroids

    pygame.time.set_timer(ADDENEMY, enemy_spawn_interval)
    pygame.time.set_timer(ADDPOWERUP, 10000)  # Spawn power-up every 10 seconds
    pygame.time.set_timer(ADDASTEROID, asteroid_spawn_interval)

    # Background image
    background = assets['game_background']
    background_x = 0  # For parallax effect

    running = True
    while running:
        pygame.time.Clock().tick(60)

        # Event handling
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                pygame.quit()
                sys.exit()
            if event.type == ADDENEMY and not paused:
                # Determine if the enemy should move randomly
                move_randomly_chance = min(10 + (level - 1) * 5, 100)  # Increase chance as level increases
                move_randomly = random.randint(1, 100) <= move_randomly_chance
                enemy = Enemy(
                    assets['enemy_img'],
                    enemy_bullets,
                    all_sprites,
                    assets,
                    move_randomly,
                    level,
                )
                all_sprites.add(enemy)
                enemies.add(enemy)
                combined_targets.add(enemy)
            if event.type == ADDPOWERUP and not paused:
                powerup_type = random.choice(['shooting', 'slow_motion', 'kill_all', 'rocket', 'spread', ])
                if powerup_type == 'shooting':
                    powerup_image = assets['powerup_img']
                elif powerup_type == 'slow_motion':
                    powerup_image = assets['slow_motion_powerup_img']
                elif powerup_type == 'kill_all':
                    powerup_image = assets['kill_all_powerup_img']
                elif powerup_type == 'rocket':
                    powerup_image = assets['rocket_powerup_img']   
                elif powerup_type == 'spread':  # Add new power-up
                    powerup_image = assets['spread_powerup_img']  # Add this to your assets
                
                powerup = PowerUp(powerup_image, powerup_type)
                all_sprites.add(powerup)
                powerups.add(powerup)
                
            if event.type == ADDASTEROID and not paused:
                asteroid = Asteroid(assets['asteroid_img'], 'large')
                all_sprites.add(asteroid)
                asteroids.add(asteroid)
                combined_targets.add(asteroid)
            if event.type == pygame.KEYDOWN:
                if event.key == pygame.K_p:
                    paused = not paused
                    for sprite in all_sprites:
                        if hasattr(sprite, 'pause'):
                            sprite.pause()
                elif event.key == pygame.K_ESCAPE:
                    click_sound.play() 
                    main_menu()
                    return  # Exit the game_loop function

        if not paused:
            # Update background position for parallax effect
            background_x -= 0.1 * game_speed_multiplier  # Adjust speed as needed
            if background_x <= -WIDTH:
                background_x = 0

            # Spawn boss when score reaches next_boss_score and only if boss hasn't spawned yet
            if score >= next_boss_score and not boss_spawned:
                boss = Boss(assets['boss_img'], enemy_bullets, all_sprites, assets, level)
                all_sprites.add(boss)
                enemies.add(boss)
                combined_targets.add(boss)
                boss_spawned = True
                # Add rockets when level increases
                player1.add_rockets(3)
                if cooperative and player2:
                    player2.add_rockets(3)

            all_sprites.update()

            # Update stars
            for layer in star_layers:
                for star in layer:
                    star.update()

            # Handle collisions between player bullets and enemies
            hits = pygame.sprite.groupcollide(enemies, bullets, False, True)
            for enemy_hit in hits:
                if isinstance(enemy_hit, Boss):
                    enemy_hit.take_damage(1)  # Each bullet does 1 damage
                    if enemy_hit.health <= 0:
                        explosion = Explosion(
                            enemy_hit.rect.center, assets['explosion_spritesheet']
                        )
                        all_sprites.add(explosion)
                        assets['explosion_sound'].play()
                        enemies.remove(enemy_hit)
                        all_sprites.remove(enemy_hit)
                        combined_targets.remove(enemy_hit)
                        score += 50  # Boss gives more points
                        boss_spawned = False
                        level += 1  # Increase level
                        # Update next boss score
                        next_boss_score += level * 100  # Increase score needed for next boss
                        # Increase difficulty
                        enemy_spawn_interval = max(500, enemy_spawn_interval - 200)
                        asteroid_spawn_interval = max(2000, asteroid_spawn_interval - 500)
                        pygame.time.set_timer(ADDENEMY, enemy_spawn_interval)
                        pygame.time.set_timer(ADDASTEROID, asteroid_spawn_interval)
                        # Add rockets for next level
                        player1.add_rockets(3)
                        if cooperative and player2:
                            player2.add_rockets(3)
                else:
                    enemy_hit.kill()
                    explosion = Explosion(
                        enemy_hit.rect.center, assets['explosion_spritesheet']
                    )
                    all_sprites.add(explosion)
                    assets['explosion_sound'].play()
                    score += 10
                    combined_targets.remove(enemy_hit)

            # Handle collisions between rockets and enemies
            hits = pygame.sprite.groupcollide(enemies, rockets, False, True)
            for enemy_hit in hits:
                if isinstance(enemy_hit, Boss):
                    enemy_hit.take_damage(4)  # Rockets do 4 damage
                    if enemy_hit.health <= 0:
                        explosion = Explosion(
                            enemy_hit.rect.center, assets['explosion_spritesheet']
                        )
                        all_sprites.add(explosion)
                        assets['explosion_sound'].play()
                        enemies.remove(enemy_hit)
                        all_sprites.remove(enemy_hit)
                        combined_targets.remove(enemy_hit)
                        score += 50  # Boss gives more points
                        boss_spawned = False
                        level += 1  # Increase level
                        # Update next boss score
                        next_boss_score += level * 100  # Increase score needed for next boss
                        # Increase difficulty
                        enemy_spawn_interval = max(500, enemy_spawn_interval - 200)
                        asteroid_spawn_interval = max(2000, asteroid_spawn_interval - 500)
                        pygame.time.set_timer(ADDENEMY, enemy_spawn_interval)
                        pygame.time.set_timer(ADDASTEROID, asteroid_spawn_interval)
                        # Add rockets for next level
                        player1.add_rockets(3)
                        if cooperative and player2:
                            player2.add_rockets(3)
                else:
                    enemy_hit.kill()
                    explosion = Explosion(
                        enemy_hit.rect.center, assets['explosion_spritesheet']
                    )
                    all_sprites.add(explosion)
                    assets['explosion_sound'].play()
                    score += 20  # Rockets give more points
                    combined_targets.remove(enemy_hit)

            # Handle collisions between player bullets and asteroids
            hits = pygame.sprite.groupcollide(asteroids, bullets, True, True)
            for asteroid_hit in hits:
                explosion = Explosion(
                    asteroid_hit.rect.center, assets['explosion_spritesheet']
                )
                all_sprites.add(explosion)
                assets['explosion_sound'].play()
                score += 5
                # Break asteroid into smaller pieces
                pieces = asteroid_hit.break_apart()
                for piece in pieces:
                    all_sprites.add(piece)
                    asteroids.add(piece)
                    combined_targets.add(piece)
                combined_targets.remove(asteroid_hit)

            # Handle collisions between rockets and asteroids
            hits = pygame.sprite.groupcollide(asteroids, rockets, True, True)
            for asteroid_hit in hits:
                explosion = Explosion(
                    asteroid_hit.rect.center, assets['explosion_spritesheet']
                )
                all_sprites.add(explosion)
                assets['explosion_sound'].play()
                score += 10
                # Do not break asteroid into smaller pieces
                combined_targets.remove(asteroid_hit)

            # Handle collisions between asteroids and enemies
            hits = pygame.sprite.groupcollide(enemies, asteroids, False, False)
            for enemy_hit, asteroid_hits in hits.items():
                for asteroid_hit in asteroid_hits:
                    if not isinstance(enemy_hit, Boss):
                        enemy_hit.kill()
                        explosion = Explosion(
                            enemy_hit.rect.center, assets['explosion_spritesheet']
                        )
                        all_sprites.add(explosion)
                        assets['explosion_sound'].play()
                        score += 10
                        combined_targets.remove(enemy_hit)

            # Handle collisions between players and enemy bullets
            for player in [player1, player2]:
                if player and player.alive:
                    hits = pygame.sprite.spritecollide(player, enemy_bullets, True)
                    if hits:
                        explosion = Explosion(player.rect.center, assets['explosion_spritesheet'])
                        all_sprites.add(explosion)
                        assets['explosion_sound'].play()
                        player.alive = False
                        all_sprites.remove(player)

            # Handle collisions between players and enemies
            for player in [player1, player2]:
                if player and player.alive:
                    hits = pygame.sprite.spritecollide(player, enemies, True)
                    if hits:
                        explosion = Explosion(player.rect.center, assets['explosion_spritesheet'])
                        all_sprites.add(explosion)
                        assets['explosion_sound'].play()
                        player.alive = False
                        all_sprites.remove(player)

            # Handle collisions between players and asteroids
            for player in [player1, player2]:
                if player and player.alive:
                    hits = pygame.sprite.spritecollide(player, asteroids, True)
                    if hits:
                        explosion = Explosion(player.rect.center, assets['explosion_spritesheet'])
                        all_sprites.add(explosion)
                        assets['explosion_sound'].play()
                        player.alive = False
                        all_sprites.remove(player)

            # Handle collisions between players and power-ups
            for player in [player1, player2]:
                if player and player.alive:
                    hits = pygame.sprite.spritecollide(player, powerups, True)
                    for hit in hits:
                        if hit.type == 'shooting':
                            player.power_up()
                            assets['powerup_sound'].play()
                        elif hit.type == 'slow_motion':
                            game_speed_multiplier = 0.5  # Slow down the game
                            slow_motion_end_time = pygame.time.get_ticks() + 10000  # 10 seconds duration
                            set_game_speed_multiplier(game_speed_multiplier)
                            assets['powerup_sound'].play()
                        elif hit.type == 'kill_all':
                            # Kill all enemies and asteroids except the boss
                            for enemy in enemies:
                                if not isinstance(enemy, Boss):
                                    enemy.kill()
                                    explosion = Explosion(enemy.rect.center, assets['explosion_spritesheet'])
                                    all_sprites.add(explosion)
                                    combined_targets.remove(enemy)
                            for asteroid in asteroids:
                                asteroid.kill()
                                explosion = Explosion(asteroid.rect.center, assets['explosion_spritesheet'])
                                all_sprites.add(explosion)
                                combined_targets.remove(asteroid)
                            assets['explosion_sound'].play()
                        elif hit.type == 'rocket':
                            player.add_rockets(1)
                            assets['powerup_sound'].play()
                        elif hit.type == 'spread':  # Spread power-up effect
                            player.increase_spread()
                            assets['powerup_sound'].play()

            # Check if slow-motion effect has ended
            if slow_motion_end_time and pygame.time.get_ticks() > slow_motion_end_time:
                game_speed_multiplier = 1.0
                set_game_speed_multiplier(game_speed_multiplier)
                slow_motion_end_time = None

            # Check if all players are dead
            if not player1.alive and (not cooperative or (cooperative and player2 and not player2.alive)):
                running = False  # End the game

        # Draw everything
        screen.fill(BLACK)

        # Draw the game background with parallax effect
        screen.blit(background, (background_x, 0))
        screen.blit(background, (background_x + WIDTH, 0))

        # Draw star layers for parallax effect
        for layer in star_layers:
            for star in layer:
                star.draw(screen)

        all_sprites.draw(screen)

        score_text = game_font.render(f"Score: {score}", True, WHITE)
        level_text = game_font.render(f"Level: {level}", True, WHITE)
        rockets_text1 = game_font.render(f"P1 Rockets: {player1.rocket_count}", True, WHITE)
        screen.blit(score_text, (10, 10))
        screen.blit(level_text, (WIDTH - 150, 10))
        screen.blit(rockets_text1, (10, 50))

        if cooperative and player2:
            rockets_text2 = game_font.render(f"P2 Rockets: {player2.rocket_count}", True, WHITE)
            screen.blit(rockets_text2, (10, 90))

        if paused:
            pause_text = game_font.render("PAUSED", True, RED)
            screen.blit(pause_text, (WIDTH // 2 - pause_text.get_width() // 2, HEIGHT // 2))

        pygame.display.flip()

    # Game Over transition
    for alpha in range(0, 128, 5):
        # Redraw the last frame
        screen.fill(BLACK)
        # Draw game background
        screen.blit(background, (background_x, 0))
        screen.blit(background, (background_x + WIDTH, 0))
        # Draw star layers
        for layer in star_layers:
            for star in layer:
                star.draw(screen)
        all_sprites.draw(screen)
        # Draw score and level
        score_text = game_font.render(f"Score: {score}", True, WHITE)
        level_text = game_font.render(f"Level: {level}", True, WHITE)
        rockets_text1 = game_font.render(f"P1 Rockets: {player1.rocket_count}", True, WHITE)
        screen.blit(score_text, (10, 10))
        screen.blit(level_text, (WIDTH - 150, 10))
        screen.blit(rockets_text1, (10, 50))
        if cooperative and player2:
            rockets_text2 = game_font.render(f"P2 Rockets: {player2.rocket_count}", True, WHITE)
            screen.blit(rockets_text2, (10, 90))
        # Create a semi-transparent surface to overlay
        dark_surface = pygame.Surface((WIDTH, HEIGHT))
        dark_surface.set_alpha(alpha)
        dark_surface.fill((0, 0, 0))
        screen.blit(dark_surface, (0, 0))
        pygame.display.flip()
        pygame.time.delay(30)

    # Game Over screen with buttons and hover effects
    game_over_text = game_over_font.render("GAME OVER", True, RED)

    retry_button = {
        "rect": pygame.Rect(WIDTH // 2 - 100, HEIGHT // 2 + 50, 200, 50),
        "color": (70, 70, 70),
        "hover_color": (0, 255, 0),
        "text": "RETRY"
    }

    main_menu_button = {
        "rect": pygame.Rect(WIDTH // 2 - 100, HEIGHT // 2 + 120, 200, 50),
        "color": (70, 70, 70),
        "hover_color": (255, 0, 0),
        "text": "MAIN MENU"
    }

    button_font = pygame.font.Font(None, 48)
    buttons = [retry_button, main_menu_button]
    current_index = 0  # Initially, select the Retry button

    while True:
        mouse_pos = pygame.mouse.get_pos()

        screen.fill(BLACK)
        screen.blit(game_over_text, (WIDTH // 2 - game_over_text.get_width() // 2, HEIGHT // 2 - 100))

        # Update selected button based on keyboard navigation (Up/Down or W/S)
        keys = pygame.key.get_pressed()
        if keys[pygame.K_DOWN] or keys[pygame.K_s]:
            current_index = (current_index + 1) % len(buttons)
            pygame.time.wait(150)  # Avoid fast cycling
        elif keys[pygame.K_UP] or keys[pygame.K_w]:
            current_index = (current_index - 1) % len(buttons)
            pygame.time.wait(150)

        # Handle hover effect and keyboard selection
        for i, button in enumerate(buttons):
            button_rect = button["rect"]
            # Only highlight if either hovered by mouse OR selected via keyboard, not both
            if button_rect.collidepoint(mouse_pos):
                current_index = i
                button_color = button["hover_color"]
            else:
                button_color = button["hover_color"] if (i == current_index) else button["color"]
            
            pygame.draw.rect(screen, button_color, button_rect)

            # Render the text and center it in the button
            text_surface = button_font.render(button["text"], True, WHITE)
            text_rect = text_surface.get_rect(center=button_rect.center)
            screen.blit(text_surface, text_rect)

        # Handle mouse click and Enter key selection
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                pygame.quit()
                sys.exit()

            if event.type == pygame.KEYDOWN:
                if event.key == pygame.K_RETURN:
                    # Check the current selected button
                    if current_index == 0:  # Retry button
                        click_sound.play()
                        game_loop(cooperative=cooperative)  # Restart the game
                        return  # Exit game_loop and restart the game
                    elif current_index == 1:  # Main Menu button
                        click_sound.play()  # Play sound when going back to the main menu
                        main_menu()  # Go back to the main menu
                        return  # Ensure game_loop is exited

            if event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
                if buttons[0]["rect"].collidepoint(mouse_pos):
                    click_sound.play()
                    game_loop(cooperative=cooperative)  # Restart the game
                    return  # Ensure game loop is exited
                elif buttons[1]["rect"].collidepoint(mouse_pos):
                    click_sound.play()  # Play click sound
                    main_menu()  # Go back to the main menu
                    return
    
        pygame.display.flip()
        pygame.time.Clock().tick(60)

