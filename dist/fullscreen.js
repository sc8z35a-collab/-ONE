export function fullscreenElement(doc=document) {
  return doc.fullscreenElement || doc.webkitFullscreenElement || null;
}

export async function setFullscreen(target,{toggle=false,landscape=false,doc=document,orientation=screen.orientation}={}) {
  const active=fullscreenElement(doc);
  try {
    if (active && toggle) {
      const exit=doc.exitFullscreen || doc.webkitExitFullscreen;
      if (!exit) return 'blocked';
      await exit.call(doc);
      return 'exited';
    }
    if (!active) {
      const standard=target.requestFullscreen && doc.fullscreenEnabled!==false;
      const legacy=target.webkitRequestFullscreen && doc.webkitFullscreenEnabled!==false;
      if (standard) {
        try { await target.requestFullscreen({navigationUI:'hide'}); }
        catch {
          if (!legacy) return 'blocked';
          await target.webkitRequestFullscreen();
        }
      } else if (legacy) await target.webkitRequestFullscreen();
      else return 'blocked';
    }
    if (landscape && orientation?.lock) {
      try { await orientation.lock('landscape'); } catch { /* Some devices only support manual rotation. */ }
    }
    return 'active';
  } catch {
    return 'blocked';
  }
}
