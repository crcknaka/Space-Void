(function (global) {
  const SpaceVoid = (global.SpaceVoid = global.SpaceVoid || {});

  function createCoopWorld(options) {
    const { GameWorld } = SpaceVoid;
    if (!GameWorld) {
      throw new Error('GameWorld is not available. Ensure single-player module is loaded first.');
    }
    return new GameWorld({ ...options, mode: 'coop' });
  }

  SpaceVoid.createCoopWorld = createCoopWorld;
})(window);
