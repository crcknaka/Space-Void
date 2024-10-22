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

# Load sound effects
hover_sound = pygame.mixer.Sound('assets/sounds/hover.wav')  # Add your hover sound file
click_sound = pygame.mixer.Sound('assets/sounds/click.wav')  # Add your click sound file

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

# Static star class (stars without parallax effect, some light up or fade out)
class StaticStar:
    def __init__(self, x, y, size, opacity):
        self.x = x
        self.y = y
        self.size = size
        self.opacity = opacity
        self.max_opacity = opacity
        self.fading = random.choice([True, False])
        self.fade_speed = random.uniform(0.1, 0.5)  # Speed of fading in or out
        
        # Randomly choose a color from white to blue (RGB values)
        # White (255, 255, 255) to Blue (0, 0, 255)
        self.color = (
            random.randint(0, 255),  # Red value
            random.randint(0, 255),  # Green value
            255                       # Blue value (always fully blue)
        )

    def update(self):
        # Randomly increase or decrease opacity to simulate light up or turn off
        if self.fading:
            self.opacity -= self.fade_speed
            if self.opacity <= 0:
                self.opacity = 0
                self.fading = False
        else:
            self.opacity += self.fade_speed
            if self.opacity >= self.max_opacity:
                self.opacity = self.max_opacity
                self.fading = True

    def draw(self, surface):
        star_surface = pygame.Surface((self.size * 1.2, self.size * 1.2), pygame.SRCALPHA)
        # Draw the star with the color and opacity
        pygame.draw.circle(
            star_surface, 
            (*self.color, int(self.opacity)),  # Color with the alpha (opacity)
            (self.size, self.size), 
            self.size
        )
        surface.blit(star_surface, (int(self.x), int(self.y)))


# Star class for parallax effect (stars that move)
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
        star_surface = pygame.Surface((self.size * 1.6, self.size * 1.6), pygame.SRCALPHA)
        pygame.draw.circle(
            star_surface,
            (255, 255, 255, self.opacity),
            (self.size, self.size),
            self.size,
        )
        surface.blit(star_surface, (int(self.x), int(self.y)))

# Initialize parallax stars for the menu
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

# Initialize static stars for the menu background
static_stars = [
    StaticStar(
        random.randint(0, WIDTH),
        random.randint(0, HEIGHT),
        random.randint(1, 4),  # Size of the static stars
        random.randint(50, 200)  # Initial opacity
    )
    for _ in range(100)  # You can increase or decrease the number of static stars
]

class Button:
    def __init__(self, text, x, y, width, height, inactive_color, active_color, action=None):
        self.text = text
        self.rect = pygame.Rect(x, y, width, height)
        self.inactive_color = inactive_color
        self.active_color = active_color
        self.action = action
        self.hovered = False
        self.selected = False  # Used for keyboard navigation
        self.width = width
        self.height = height
        self.original_width = width
        self.original_height = height
        self.growth_factor = 1.1  # Button grows by 10% when hovered or selected
        self.text_size = 48  # Font size
        self.text_growth_factor = 1.1  # Font grows slightly as well

    def draw(self, surface):
        # Choose color based on hover or selected state
        color = self.active_color if self.hovered or self.selected else self.inactive_color
        current_width = self.width
        current_height = self.height
        
        # If hovered or selected, increase the size of the button smoothly
        if self.hovered or self.selected:
            current_width = int(self.original_width * self.growth_factor)
            current_height = int(self.original_height * self.growth_factor)
        
        # Recalculate the button's rect to center the enlarged button
        rect = pygame.Rect(
            self.rect.centerx - current_width // 2,
            self.rect.centery - current_height // 2,
            current_width,
            current_height
        )
        
        pygame.draw.rect(surface, color, rect, border_radius=5)
        
        # Adjust font size when hovered or selected
        font_size = int(self.text_size * (self.text_growth_factor if self.hovered or self.selected else 1))
        text_font = pygame.font.Font(None, font_size)
        text_surf = text_font.render(self.text, True, WHITE)
        text_rect = text_surf.get_rect(center=rect.center)
        surface.blit(text_surf, text_rect)

    def update(self, mouse_pos, play_hover_sound):
        is_hovered = self.rect.collidepoint(mouse_pos)
        if is_hovered and not self.hovered and play_hover_sound:
            hover_sound.play()  # Play the hover sound
        self.hovered = is_hovered


def main_menu():
    parallax_factor = 0.02  # Adjust this value for more or less parallax effect

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
        "COOP",
        WIDTH // 2 - 100,  
        HEIGHT // 2 - 60,
        200,        
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
    current_index = 0  # Keep track of the selected button
    buttons[current_index].selected = True  # Highlight the first button

    play_hover_sound = True  # Ensure the hover sound plays only once per hover

    while True:
        mouse_pos = pygame.mouse.get_pos()

        # Handle keyboard navigation
        keys = pygame.key.get_pressed()
        if keys[pygame.K_DOWN] or keys[pygame.K_s]:
            buttons[current_index].selected = False
            current_index = (current_index + 1) % len(buttons)  # Move to the next button
            buttons[current_index].selected = True
            hover_sound.play()  # Play hover sound when navigating with the keyboard
            pygame.time.wait(150)  # Add a small delay to avoid instant skipping
        elif keys[pygame.K_UP] or keys[pygame.K_w]:
            buttons[current_index].selected = False
            current_index = (current_index - 1) % len(buttons)  # Move to the previous button
            buttons[current_index].selected = True
            hover_sound.play()  # Play hover sound when navigating with the keyboard
            pygame.time.wait(150)

        # Trigger action for the selected button with Enter key
        if keys[pygame.K_RETURN]:
            result = buttons[current_index].action()
            if result is not None:
                click_sound.play()  # Play the click sound when pressing Enter
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

        # Reset keyboard selection when the mouse hovers over any button
        for i, button in enumerate(buttons):
            button.update(mouse_pos, play_hover_sound)
            if button.hovered:
                buttons[current_index].selected = False
                current_index = i
                buttons[current_index].selected = True

        # Handle mouse click events
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                pygame.quit()
                sys.exit()
            if event.type == pygame.MOUSEBUTTONDOWN:
                if event.button == 1:  # Left mouse button
                    if buttons[current_index].hovered:
                        click_sound.play()  # Play the click sound
                        result = buttons[current_index].action()
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

        # Calculate offset for parallax effect
        offset_x = -(mouse_pos[0] - WIDTH // -1) * parallax_factor
        offset_y = -(mouse_pos[1] - HEIGHT // 2) * parallax_factor

        # Ensure the background fills the screen even when offset
        screen.fill(BACKGROUND_COLOR)
        bg_x = (WIDTH - new_bg_width) // 4
        bg_y = (HEIGHT - new_bg_height) // 1
        screen.blit(menu_background_scaled, (bg_x + offset_x, bg_y + offset_y))

        # Update and draw static stars (non-parallax stars)
        for static_star in static_stars:
            static_star.update()
            static_star.draw(screen)

        # Update and draw parallax stars (moving stars)
        for star in menu_stars:
            star.update()
            star.draw(screen)

        # Draw the game title
        title_text = title_font.render("SPACE VOID v0.7", True, WHITE)
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
            button.draw(screen)

        pygame.display.flip()
        pygame.time.Clock().tick(60)
