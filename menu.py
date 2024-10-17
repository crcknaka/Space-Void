# menu.py
import pygame
import random
import sys
from game_assets import load_assets
from settings import WIDTH, HEIGHT, FULLSCREEN  # Import screen dimensions from settings

# Initialize Pygame modules
pygame.init()
pygame.font.init()  # Ensure font module is initialized
font = pygame.font.Font(None, 36)  # Default font
author_font = pygame.font.Font(None, 24)  # Smaller font for author text

# Screen dimensions
# Set screen mode based on FULLSCREEN flag
if FULLSCREEN:
    screen = pygame.display.set_mode((WIDTH, HEIGHT), pygame.FULLSCREEN)  # Full-screen mode
else:
    screen = pygame.display.set_mode((WIDTH, HEIGHT))  # Windowed mode

# Colors
WHITE = (255, 255, 255)
HOVER_GREEN = (0, 255, 0)
HOVER_BLUE = (0, 0, 255)
HOVER_RED = (255, 0, 0)
HOVER_ORANGE = (255, 140, 0)  # Dark orange for Versus button
BACKGROUND_COLOR = (0, 0, 0)

# Load assets
assets = load_assets()
menu_background = assets['menu_background']

# Get background image size and aspect ratio
bg_width, bg_height = menu_background.get_size()
bg_aspect_ratio = bg_width / bg_height

# Resize background to fit the screen while maintaining aspect ratio
if WIDTH / HEIGHT > bg_aspect_ratio:
    # Screen is wider than the background aspect ratio, so fit by height
    new_bg_height = HEIGHT
    new_bg_width = int(HEIGHT * bg_aspect_ratio)
else:
    # Screen is taller than the background aspect ratio, so fit by width
    new_bg_width = WIDTH
    new_bg_height = int(WIDTH / bg_aspect_ratio)

# Scale the background image while keeping the aspect ratio
menu_background_scaled = pygame.transform.scale(menu_background, (new_bg_width, new_bg_height))

# Fonts
button_font = pygame.font.Font(None, 48)  # Use default font
title_font = pygame.font.Font(None, 72)

# Star class for the menu background
class Star:
    def __init__(self, x, y, speed, size, opacity):
        self.x = x
        self.y = y
        self.speed = speed
        self.size = size
        self.opacity = opacity

    def update(self):
        self.x -= self.speed
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

# Initialize stars for the menu
menu_stars = [
    Star(
        random.randint(0, WIDTH),
        random.randint(0, HEIGHT),
        random.uniform(0.1, 0.3),
        random.randint(1, 3),
        random.randint(50, 200),
    )
    for _ in range(50)
]

class Button:
    def __init__(self, text, x, y, width, height, inactive_color, active_color, action=None):
        self.text = text
        self.rect = pygame.Rect(x, y, width, height)
        self.inactive_color = inactive_color
        self.active_color = active_color
        self.action = action
        self.hovered = False

    def draw(self, surface):
        color = self.active_color if self.hovered else self.inactive_color
        pygame.draw.rect(surface, color, self.rect, border_radius=5)
        text_surf = button_font.render(self.text, True, WHITE)
        text_rect = text_surf.get_rect(center=self.rect.center)
        surface.blit(text_surf, text_rect)

    def update(self, mouse_pos, mouse_click):
        self.hovered = self.rect.collidepoint(mouse_pos)
        if self.hovered and mouse_click[0]:
            return self.action()
        return None

def main_menu():
    parallax_factor = 0.03  # Adjust this value for more or less parallax effect

    # Define buttons
    start_button = Button(
        "SINGLE",
        WIDTH // 2 - 100,
        HEIGHT // 2 - 140,
        200,
        60,
        (70, 70, 70),
        HOVER_GREEN,
        action=lambda: 'single',
    )
    coop_button = Button(
        "COOPERATIVE",
        WIDTH // 2 - 140,  
        HEIGHT // 2 - 60,
        280,               # Increased width for better fit
        60,
        (70, 70, 70),
        HOVER_BLUE,
        action=lambda: 'cooperative',
    )
    versus_button = Button(
        "VERSUS",
        WIDTH // 2 - 100,
        HEIGHT // 2 + 20,
        200,
        60,
        (70, 70, 70),
        HOVER_ORANGE,
        action=lambda: 'versus',
    )
    exit_button = Button(
        "EXIT",
        WIDTH // 2 - 100,
        HEIGHT // 2 + 100,
        200,
        60,
        (70, 70, 70),
        HOVER_RED,
        action=lambda: 'exit',
    )

    buttons = [start_button, coop_button, versus_button, exit_button]

    while True:
        mouse_pos = pygame.mouse.get_pos()
        mouse_click = pygame.mouse.get_pressed()

        # Calculate offset for parallax effect
        offset_x = -(mouse_pos[0] - WIDTH // 1) * parallax_factor
        offset_y = -(mouse_pos[1] - HEIGHT // 3) * parallax_factor

        # Ensure the background fills the screen even when offset
        screen.fill(BACKGROUND_COLOR)  # Fill with black before blitting background
       # Center the background image based on its scaled size
        bg_x = (WIDTH - new_bg_width) // 2
        bg_y = (HEIGHT - new_bg_height) // 2
        screen.blit(menu_background_scaled, (bg_x + offset_x, bg_y + offset_y))

        # Update and draw stars
        for star in menu_stars:
            star.update()
            star.draw(screen)

        # Draw the game title
        title_text = title_font.render("Space Void v0.5", True, WHITE)
        title_rect = title_text.get_rect(center=(WIDTH // 2, HEIGHT // 2 - 240))
        screen.blit(title_text, title_rect)

        # Draw author text in the bottom-right corner
        author_text = "Made by cRc^"
        author_surface = author_font.render(author_text, True, WHITE)
        author_rect = author_surface.get_rect()
        author_rect.bottomright = (WIDTH - 10, HEIGHT - 10)  # 10 pixels from the edge for padding
        screen.blit(author_surface, author_rect)

        # Update and draw buttons
        for button in buttons:
            result = button.update(mouse_pos, mouse_click)
            if result is not None:
                if result == 'single':
                    from game import game_loop
                    game_loop(cooperative=False)
                    return
                elif result == 'cooperative':
                    from game import game_loop
                    game_loop(cooperative=True)
                    return
                elif result == 'versus':
                    from versus import versus_loop
                    versus_loop()
                    return
                elif result == 'exit':
                    pygame.quit()
                    sys.exit()
            button.draw(screen)

        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                pygame.quit()
                sys.exit()

        pygame.display.flip()
        pygame.time.Clock().tick(60)
