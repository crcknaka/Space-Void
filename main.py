# main.py
import pygame
import sys
from menu import main_menu
from settings import WIDTH, HEIGHT, FULLSCREEN  # Import screen dimensions from settings

# Initialize Pygame and the mixer module
pygame.init()
pygame.mixer.init()
pygame.font.init()  # Ensure font module is initialized
pygame.display.set_caption("SPACE VOID v0.7")
icon = pygame.image.load('assets/images/icon.png')

# Screen dimensions
# screen = pygame.display.set_mode((WIDTH, HEIGHT)) 
# Set screen mode based on FULLSCREEN flag
if FULLSCREEN:
    screen = pygame.display.set_mode((WIDTH, HEIGHT), pygame.FULLSCREEN)  # Full-screen mode
else:
    screen = pygame.display.set_mode((WIDTH, HEIGHT))  # Windowed mode

def main():
    pygame.mixer.music.load('assets/sounds/background_music.mp3')
    pygame.mixer.music.play(-1)  # Loop the music indefinitely
    

if __name__ == "__main__":
    main()

# Set the window icon
    pygame.display.set_icon(icon)

    while True:
        main_menu() 