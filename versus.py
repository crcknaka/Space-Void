# versus.py
import pygame
import random
import sys
from game_classes import Player, Explosion, Star
from game_assets import load_assets
from settings import WIDTH, HEIGHT, FULLSCREEN  # Import screen dimensions from settings

click_sound = pygame.mixer.Sound('assets/sounds/click.wav')  # Add your click sound file
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
game_over_font = pygame.font.Font(None, 72)

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

    while running:
        pygame.time.Clock().tick(60)

        # Event handling
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                pygame.quit()
                sys.exit()
            if event.type == pygame.KEYDOWN:
                if event.key == pygame.K_ESCAPE:
                    click_sound.play() 
                    from menu import main_menu
                    main_menu()
                    return
                if event.key == pygame.K_p:
                    paused = not paused
                    for sprite in all_sprites:
                        if hasattr(sprite, 'pause'):
                            sprite.pause()
        if paused:
            # Draw PAUSE text in the center of the screen when paused
            pause_text = game_font.render("PAUSE", True, RED)
            screen.blit(pause_text, (WIDTH // 2 - pause_text.get_width() // 2, HEIGHT // 2))
            
            pygame.display.flip()
            continue  # Skip the rest of the loop while paused
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
                hits = pygame.sprite.spritecollide(player1, bullets_p2, True)
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
                hits = pygame.sprite.spritecollide(player2, bullets_p1, True)
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

    # Game Over Screen
    game_over_text = game_over_font.render(f"{winner} WINS!", True, RED)

    # Define the buttons for retry and main menu
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
                    if current_index == 0:  # Retry button is selected
                        click_sound.play()
                        versus_loop()  # Restart versus mode
                        return
                    elif current_index == 1:  # Main Menu button is selected
                        click_sound.play()
                        from menu import main_menu
                        main_menu()  # Return to main menu
                        return
            if event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
                if retry_button["rect"].collidepoint(mouse_pos):
                    click_sound.play()
                    versus_loop()  # Restart versus mode
                    return
                if main_menu_button["rect"].collidepoint(mouse_pos):
                    click_sound.play()
                    from menu import main_menu
                    main_menu()  # Return to main menu
                    return


        pygame.display.flip()
        pygame.time.Clock().tick(60)