import pygame
import sys

# Define colors
WHITE = (255, 255, 255)
HOVER_GREEN = (0, 255, 0)
HOVER_RED = (255, 0, 0)
BACKGROUND_COLOR = (0, 0, 0)

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
        # Choose the color based on the hover or selected state
        color = self.active_color if self.hovered or self.selected else self.inactive_color
        current_width = self.width
        current_height = self.height

        # If hovered or selected, increase the size of the button
        if self.hovered or self.selected:
            current_width = int(self.width * self.growth_factor)
            current_height = int(self.height * self.growth_factor)

        # Recalculate the button's rect to center the enlarged button
        rect = pygame.Rect(self.rect.centerx - current_width // 2, self.rect.centery - current_height // 2,
                           current_width, current_height)
        pygame.draw.rect(surface, color, rect, border_radius=5)

        # Render the text and center it in the button
        font = pygame.font.Font(None, self.text_size)
        text_surface = font.render(self.text, True, WHITE)
        text_rect = text_surface.get_rect(center=rect.center)
        surface.blit(text_surface, text_rect)

    def update(self, mouse_pos, play_hover_sound):
        # Check if the button is hovered
        is_hovered = self.rect.collidepoint(mouse_pos)
        if is_hovered and not self.hovered and play_hover_sound:
            play_hover_sound.play()  # Play hover sound
        self.hovered = is_hovered

class GameOverMenu:
    def __init__(self, screen, cooperative, score_p1, score_p2, click_sound, hover_sound):
        self.screen = screen
        self.cooperative = cooperative
        self.score_p1 = score_p1
        self.score_p2 = score_p2
        self.click_sound = click_sound
        self.hover_sound = hover_sound
        self.font = pygame.font.Font(None, 72)  # Font for "Game Over"
        self.buttons = [
            Button("RETRY", screen.get_width() // 2 - 100, screen.get_height() // 2 + 50, 200, 60, (70, 70, 70), HOVER_GREEN, action="retry"),
            Button("MAIN MENU", screen.get_width() // 2 - 100, screen.get_height() // 2 + 120, 200, 60, (70, 70, 70), HOVER_RED, action="main_menu"),
        ]
        self.current_index = 0  # Selected button index
        self.buttons[self.current_index].selected = True  # Initially, select the Retry button
        self.game_over_text = self.font.render("GAME OVER", True, WHITE)
        if cooperative:
            self.p1_score_text = game_font.render(f"P1 Score: {self.score_p1}", True, WHITE)
            self.p2_score_text = game_font.render(f"P2 Score: {self.score_p2}", True, WHITE)
        else:
            self.score_text = game_font.render(f"Score: {self.score_p1}", True, WHITE)

    def draw(self):
        # Draw the background
        self.screen.fill(BLACK)
        
        # Draw "GAME OVER" text
        text_rect = self.game_over_text.get_rect(center=(self.screen.get_width() // 2, self.screen.get_height() // 2 - 100))
        self.screen.blit(self.game_over_text, text_rect)
        
        # Draw scores
        if self.cooperative:
            p1_rect = self.p1_score_text.get_rect(center=(self.screen.get_width() // 2, self.screen.get_height() // 2 - 50))
            p2_rect = self.p2_score_text.get_rect(center=(self.screen.get_width() // 2, self.screen.get_height() // 2))
            self.screen.blit(self.p1_score_text, p1_rect)
            self.screen.blit(self.p2_score_text, p2_rect)
        else:
            score_rect = self.score_text.get_rect(center=(self.screen.get_width() // 2, self.screen.get_height() // 2 - 50))
            self.screen.blit(self.score_text, score_rect)
        
        # Draw buttons
        for button in self.buttons:
            button.draw(self.screen)
    
    def handle_event(self, event):
        # Handle keyboard navigation
        if event.type == pygame.KEYDOWN:
            if event.key == pygame.K_DOWN or event.key == pygame.K_s:
                # Move selection down
                self.buttons[self.current_index].selected = False
                self.current_index = (self.current_index + 1) % len(self.buttons)
                self.buttons[self.current_index].selected = True
                self.hover_sound.play()
                pygame.time.wait(150)  # Delay to avoid fast cycling
            elif event.key == pygame.K_UP or event.key == pygame.K_w:
                # Move selection up
                self.buttons[self.current_index].selected = False
                self.current_index = (self.current_index - 1) % len(self.buttons)
                self.buttons[self.current_index].selected = True
                self.hover_sound.play()
                pygame.time.wait(150)
            elif event.key == pygame.K_RETURN:
                # Trigger action
                result = self.buttons[self.current_index].action
                self.click_sound.play()
                return result
        return None
    
    def handle_mouse_event(self, event, mouse_pos):
        # Handle mouse click
        if event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
            for button in self.buttons:
                if button.rect.collidepoint(mouse_pos):
                    self.click_sound.play()
                    return button.action
        return None
    
    def update(self, mouse_pos):
        # Update button hover states
        for button in self.buttons:
            button.update(mouse_pos, self.hover_sound)

