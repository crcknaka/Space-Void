import pygame

# Define colors
WHITE = (255, 255, 255)
HOVER_GREEN = (0, 255, 0)
HOVER_RED = (255, 0, 0)
TRANSPARENT_BLACK = (0, 0, 0, 128)  # RGBA for semi-transparent black

class Button:
    def __init__(self, text, x, y, width, height, inactive_color, active_color, action=None):
        self.text = text
        self.rect = pygame.Rect(x, y, width, height)
        self.inactive_color = inactive_color
        self.active_color = active_color
        self.action = action
        self.hovered = False
        self.selected = False
        self.width = width
        self.height = height
        self.text_size = 48
        self.growth_factor = 1.1

    def draw(self, surface):
        # Determine the button's current color based on hover/selection state
        color = self.active_color if self.hovered or self.selected else self.inactive_color
        
        # Calculate the button's size based on whether it's hovered or selected
        current_width = self.width
        current_height = self.height
        if self.hovered or self.selected:
            current_width = int(self.width * self.growth_factor)
            current_height = int(self.height * self.growth_factor)
        
        # Adjust the rect to be centered after resizing
        rect = pygame.Rect(self.rect.centerx - current_width // 2, self.rect.centery - current_height // 2,
                           current_width, current_height)
        pygame.draw.rect(surface, color, rect, border_radius=5)
        
        # Render the button's text and center it
        font = pygame.font.Font(None, self.text_size)
        text_surface = font.render(self.text, True, WHITE)
        text_rect = text_surface.get_rect(center=rect.center)
        surface.blit(text_surface, text_rect)

    def update(self, mouse_pos, play_hover_sound):
        # Check if the mouse is hovering over the button
        is_hovered = self.rect.collidepoint(mouse_pos)
        if is_hovered and not self.hovered:
            play_hover_sound.play()  # Play hover sound if first time hovering
        self.hovered = is_hovered

class PauseMenu:
    def __init__(self, screen, click_sound, hover_sound):
        self.screen = screen
        self.click_sound = click_sound
        self.hover_sound = hover_sound
        self.buttons = [
            Button("RESUME", screen.get_width() // 2 - 100, screen.get_height() // 2 - 50, 200, 60, (70, 70, 70), HOVER_GREEN, action="resume"),
            Button("MAIN MENU", screen.get_width() // 2 - 100, screen.get_height() // 2 + 50, 200, 60, (70, 70, 70), HOVER_RED, action="main_menu"),
        ]
        self.current_index = 0  # Initially selected button index
        self.buttons[self.current_index].selected = True  # Select the first button initially

    def draw(self):
        # Create a semi-transparent overlay
        overlay = pygame.Surface(self.screen.get_size(), pygame.SRCALPHA)  # Create a surface with alpha channel
        overlay.fill(TRANSPARENT_BLACK)  # Fill it with semi-transparent black
        self.screen.blit(overlay, (50, 50))  # Draw it over the entire screen

        # Draw each button
        for button in self.buttons:
            button.draw(self.screen)

        pygame.display.flip()

    def handle_event(self, event):
        # Handle keyboard navigation
        if event.type == pygame.KEYDOWN:
            if event.key == pygame.K_DOWN or event.key == pygame.K_s:
                # Move selection down
                self.buttons[self.current_index].selected = False
                self.current_index = (self.current_index + 1) % len(self.buttons)
                self.buttons[self.current_index].selected = True
                self.hover_sound.play()

            elif event.key == pygame.K_UP or event.key == pygame.K_w:
                # Move selection up
                self.buttons[self.current_index].selected = False
                self.current_index = (self.current_index - 1) % len(self.buttons)
                self.buttons[self.current_index].selected = True
                self.hover_sound.play()

            # Trigger action with Enter key
            elif event.key == pygame.K_RETURN:
                result = self.buttons[self.current_index].action
                self.click_sound.play()
                return result

        return None

    def update(self, mouse_pos):
        # Update button hover states
        for button in self.buttons:
            button.update(mouse_pos, self.hover_sound)

    def handle_mouse_event(self, event, mouse_pos):
        # Handle mouse clicks
        if event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
            for button in self.buttons:
                if button.rect.collidepoint(mouse_pos):
                    self.click_sound.play()
                    return button.action

        return None
