# main.py
import pygame
import sys
from menu import main_menu

# Initialize Pygame and the mixer module
pygame.init()
pygame.mixer.init()
pygame.font.init()  # Ensure font module is initialized

def main():
    pygame.mixer.music.load('assets/sounds/background_music.mp3')
    pygame.mixer.music.play(-1)  # Loop the music indefinitely
    
    pygame.display.set_caption("Space Void v0.5")
    icon = pygame.image.load('assets/images/icon.png')

# Set the window icon
    pygame.display.set_icon(icon)

    while True:
        main_menu() 

if __name__ == "__main__":
    main()

