import pygame
import random
import sys
from game_classes import Player, Explosion, Star
from game_assets import load_assets
from settings import WIDTH, HEIGHT, FULLSCREEN  # Import screen dimensions from settings
from pause_menu import PauseMenu  # Import the PauseMenu
from gameover_menu import GameOverMenu  # Import the new GameOverMenu

click_sound = pygame.mixer.Sound('assets/sounds/click.wav')  # Add your click sound file
hover_sound = pygame.mixer.Sound('assets/sounds/hover.wav')  # Add your hover sound file

# Initialize Pygame modules
pygame.init()
pygame.font.init()  # Ensure font module is initialized

# Screen dimensions
# Set screen mode based on FULLSCREEN flag
if FULLSCREEN:
    screen = pygame.display.set_mode((WIDTH, HEIGHT), pygame.FULLSCREEN)  # Full-screen mode
else:
    screen = pygame.display.set_mode((WIDTH, HEIGHT))  # Windowed mode
    
# Bullet class specific to versus mode
class BulletVersus(pygame.sprite.Sprite):
    def __init__(self, x, y, image, speedx):
        super().__init__()
        self.image = image
        self.rect = self.image.get_rect()
        if speedx > 0:
            self.rect.left = x
        else:
            self.rect.right = x
        self.rect.centery = y
        self.speedx = speedx

    def update(self):
        self.rect.x += self.speedx
        if self.rect.left > WIDTH or self.rect.right < 0:
            self.kill()

# Colors
WHITE = (255, 255, 255)
BLACK = (0, 0, 0)
RED = (255, 0, 0)

assets = load_assets()

# Fonts
game_font = pygame.font.Font(None, 36)  # Default font

def versus_loop():
    pygame.mixer.music.load('assets/sounds/versus_music.mp3')
    pygame.mixer.music.play(-1)  # Loop the music indefinitely

    # Scores
    score_limit = 10
    player1_score = 0
    player2_score = 0

    all_sprites = pygame.sprite.Group()
    bullets_p1 = pygame.sprite.Group()
    bullets_p2 = pygame.sprite.Group()

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

    # Define controls for both players
    player1_controls = {
        'up': pygame.K_w,
        'down': pygame.K_s,
        'left': pygame.K_a,
        'right': pygame.K_d,
        'shoot': pygame.K_SPACE,
        'speed': pygame.K_LSHIFT,
    }

    player2_controls = {
        'up': pygame.K_UP,
        'down': pygame.K_DOWN,
        'left': pygame.K_LEFT,
        'right': pygame.K_RIGHT,
        'shoot': pygame.K_RETURN,
        'speed': pygame.K_KP0,  # Numpad 0
    }

    def spawn_player1():
        x = random.randint(50, WIDTH // 2 - 50)
        y = random.randint(50, HEIGHT - 50)
        player1.rect.left = x
        player1.rect.centery = y

    def spawn_player2():
        x = random.randint(WIDTH // 2 + 50, WIDTH - 50)
        y = random.randint(50, HEIGHT - 50)
        player2.rect.right = x
        player2.rect.centery = y

    # Initialize empty groups for rockets and targets
    empty_rockets_group = pygame.sprite.Group()
    empty_targets_group = pygame.sprite.Group()

    # Player 1 setup
    player1 = Player(
        assets['player1_img'],
        assets['player1_thruster_frames'],
        bullets_p1,
        empty_rockets_group,
        all_sprites,
        empty_targets_group,
        assets,
        player1_controls,
        facing_left=False
    )
    spawn_player1()

    # Player 2 setup (facing left)
    player2_image = pygame.transform.flip(assets['player2_img'], True, False)
    player2_thrusters = assets['player2_thruster_frames']
    player2 = Player(
        player2_image,
        player2_thrusters,
        bullets_p2,
        empty_rockets_group,
        all_sprites,
        empty_targets_group,
        assets,
        player2_controls,
        facing_left=True
    )
    spawn_player2()

    all_sprites.add(player1)
    all_sprites.add(player2)

    # Background image
    background = assets['versus_background']
    background_x = 0  # For parallax effect

    running = True
    paused = False
    game_over = False
    winner = None
    respawn_timer_p1 = None
    respawn_timer_p2 = None

    # Initialize the pause menu
    pause_menu = PauseMenu(screen, click_sound, hover_sound)

    def unpause_sprites():
        """ Unpauses all sprites and restores their movement and action. """
        for sprite in all_sprites:
            if hasattr(sprite, 'pause') and sprite.paused:  # Check if the sprite is paused
                sprite.pause()  # Unpause the sprite

    while running:
        pygame.time.Clock().tick(60)

        if paused:
            # Draw game elements first (stars, players, bullets, etc.) so they are visible behind the pause menu
            screen.fill(BLACK)

            # Draw the game background with parallax effect
            screen.blit(background, (background_x, 0))
            screen.blit(background, (background_x + WIDTH, 0))

            # Draw star layers for parallax effect
            for layer in star_layers:
                for star in layer:
                    star.draw(screen)

            all_sprites.draw(screen)

            # Draw scores
            score_text_p1 = game_font.render(f"P1 Score: {player1_score}", True, WHITE)
            score_text_p2 = game_font.render(f"P2 Score: {player2_score}", True, WHITE)
            screen.blit(score_text_p1, (10, 10))
            screen.blit(score_text_p2, (WIDTH - score_text_p2.get_width() - 10, 10))

            # Handle pause menu interactions while the game is paused
            mouse_pos = pygame.mouse.get_pos()
            pause_menu.update(mouse_pos)
            pause_menu.draw()  # Draw the pause menu with the transparent overlay on top of the game

            # Handle pause menu events in one place
            for event in pygame.event.get():
                if event.type == pygame.QUIT:
                    pygame.quit()
                    sys.exit()
                result = pause_menu.handle_mouse_event(event, mouse_pos) or pause_menu.handle_event(event)
                if result == "resume":
                    paused = False
                    unpause_sprites()  # Unpause the sprites when resuming
                elif result == "main_menu":
                    from menu import main_menu
                    main_menu()  # Go back to the main menu
                    return  # Exit the current game loop

            # Skip the rest of the loop while paused
            pygame.display.flip()
            continue

        # Event handling when game is not paused
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                pygame.quit()
                sys.exit()

            # Toggle pause state
            if event.type == pygame.KEYDOWN and event.key == pygame.K_ESCAPE:
                paused = True  # Set paused state to true
                for sprite in all_sprites:
                    if hasattr(sprite, 'pause'):
                        sprite.pause()

        # Game logic when not paused
        if not paused:
            # Update background position for parallax effect
            background_x -= 0.1  # Adjust speed as needed
            if background_x <= -WIDTH:
                background_x = 0

            all_sprites.update()

            # Update stars
            for layer in star_layers:
                for star in layer:
                    star.update()

            # Handle shooting for Player 1
            now = pygame.time.get_ticks()
            keys = pygame.key.get_pressed()
            if player1.alive:
                if keys[player1_controls['shoot']]:
                    if now - player1.last_shot > player1.shoot_delay:
                        bullet = BulletVersus(
                            player1.rect.right,
                            player1.rect.centery,
                            assets['bullet_img'],
                            player1.bullet_speedx  # Bullet speed
                        )
                        bullets_p1.add(bullet)
                        all_sprites.add(bullet)
                        player1.last_shot = now
                        assets['gun_sound'].play()

            # Handle shooting for Player 2
            if player2.alive:
                if keys[player2_controls['shoot']]:
                    if now - player2.last_shot > player2.shoot_delay:
                        bullet = BulletVersus(
                            player2.rect.left,
                            player2.rect.centery,
                            pygame.transform.flip(assets['bullet_img'], True, False),
                            player2.bullet_speedx  # Bullet speed
                        )
                        bullets_p2.add(bullet)
                        all_sprites.add(bullet)
                        player2.last_shot = now
                        assets['gun_sound'].play()

            # Handle collisions between bullets and players
            if player1.alive:
                hits = pygame.sprite.spritecollide(player1, bullets_p2, True, pygame.sprite.collide_mask)
                if hits:
                    explosion = Explosion(player1.rect.center, assets['explosion_spritesheet'])
                    all_sprites.add(explosion)
                    assets['explosion_sound'].play()
                    player1.alive = False
                    all_sprites.remove(player1)
                    player2_score += 1
                    respawn_timer_p1 = pygame.time.get_ticks() + 2000  # 2 seconds
                    assets['player2_kill_sound'].play()

            if player2.alive:
                hits = pygame.sprite.spritecollide(player2, bullets_p1, True, pygame.sprite.collide_mask)
                if hits:
                    explosion = Explosion(player2.rect.center, assets['explosion_spritesheet'])
                    all_sprites.add(explosion)
                    assets['explosion_sound'].play()
                    player2.alive = False
                    all_sprites.remove(player2)
                    player1_score += 1
                    respawn_timer_p2 = pygame.time.get_ticks() + 2000  # 2 seconds
                    assets['player1_kill_sound'].play()

            # Respawn players
            if not player1.alive and respawn_timer_p1 and pygame.time.get_ticks() > respawn_timer_p1:
                spawn_player1()
                player1.alive = True
                all_sprites.add(player1)
                respawn_timer_p1 = None

            if not player2.alive and respawn_timer_p2 and pygame.time.get_ticks() > respawn_timer_p2:
                spawn_player2()
                player2.alive = True
                all_sprites.add(player2)
                respawn_timer_p2 = None

            # Check for winner
            if player1_score >= score_limit:
                game_over = True
                winner = "Player 1"
            elif player2_score >= score_limit:
                game_over = True
                winner = "Player 2"

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

        # Draw scores
        score_text_p1 = game_font.render(f"P1 Score: {player1_score}", True, WHITE)
        score_text_p2 = game_font.render(f"P2 Score: {player2_score}", True, WHITE)
        screen.blit(score_text_p1, (10, 10))
        screen.blit(score_text_p2, (WIDTH - score_text_p2.get_width() - 10, 10))

        pygame.display.flip()

        if game_over:
            break

    # Show the Game Over Menu
    gameover_menu = GameOverMenu(screen, winner, click_sound, hover_sound)

    while True:
        mouse_pos = pygame.mouse.get_pos()

        gameover_menu.update(mouse_pos)
        gameover_menu.draw()

        # Handle mouse and keyboard events for the Game Over menu
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                pygame.quit()
                sys.exit()

            result = gameover_menu.handle_mouse_event(event, mouse_pos) or gameover_menu.handle_event(event)
            if result == "retry":
                versus_loop()  # Restart versus mode
                return
            elif result == "main_menu":
                from menu import main_menu
                main_menu()  # Return to main menu
                return


