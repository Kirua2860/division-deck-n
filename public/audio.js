// Douzième Division — réglages locaux + moteur de sons synthétisés (aucun fichier audio).
// Les réglages sont gardés dans le navigateur (localStorage) : chaque appareil a les siens.
(function () {
  const KEY = "xii-settings-v1";
  const DEFAULTS = {
    muted: false,
    master: 70,      // volume général 0-100
    booster: 85,     // sons d'ouverture des boosters
    ui: 40,          // petits sons de l'interface
    jingles: true,   // jingle selon la rareté de chaque carte
    ready: true,     // carillon quand le booster est prêt
    uiSounds: true,  // clics / survol
    particles: true, // braises néon en fond
    slashes: true,   // coups de sabre
    glow: true,      // aura pulsante des cartes rares
    calm: false,     // animations réduites
  };

  let S = { ...DEFAULTS };
  try { Object.assign(S, JSON.parse(localStorage.getItem(KEY) || "{}")); } catch (e) {}

  const bus = new EventTarget();
  const Settings = {
    DEFAULTS,
    get: (k) => S[k],
    all: () => ({ ...S }),
    set(k, v) {
      S[k] = v;
      try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {}
      applyBody();
      applyVolumes();
      bus.dispatchEvent(new Event("change"));
    },
    patch(obj) { Object.keys(obj).forEach((k) => (S[k] = obj[k])); try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} applyBody(); applyVolumes(); bus.dispatchEvent(new Event("change")); },
    reset() { S = { ...DEFAULTS }; try { localStorage.removeItem(KEY); } catch (e) {} applyBody(); applyVolumes(); bus.dispatchEvent(new Event("change")); },
    on: (fn) => bus.addEventListener("change", fn),
  };

  function applyBody() {
    const c = document.body && document.body.classList;
    if (!c) return;
    c.toggle("fx-noglow", !S.glow);
    c.toggle("fx-calm", !!S.calm);
  }
  document.addEventListener("DOMContentLoaded", applyBody);

  // ---------- Moteur audio ----------
  let ctx = null, master = null, bB = null, bU = null;
  const curve = (v) => Math.pow(Math.max(0, Math.min(100, v)) / 100, 2);

  function applyVolumes() {
    if (!ctx) return;
    const t = ctx.currentTime;
    master.gain.setTargetAtTime(S.muted ? 0 : curve(S.master), t, 0.02);
    bB.gain.setTargetAtTime(curve(S.booster), t, 0.02);
    bU.gain.setTargetAtTime(curve(S.ui), t, 0.02);
  }

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      const comp = ctx.createDynamicsCompressor();
      master = ctx.createGain(); bB = ctx.createGain(); bU = ctx.createGain();
      bB.connect(master); bU.connect(master); master.connect(comp); comp.connect(ctx.destination);
      applyVolumes();
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  // Débloque l'audio dès le premier geste de l'utilisateur.
  ["pointerdown", "keydown", "touchstart"].forEach((ev) => addEventListener(ev, ensure, { once: true, passive: true }));

  let noiseBuf = null;
  function noiseBuffer() {
    if (noiseBuf) return noiseBuf;
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }

  // Note : oscillateur avec enveloppe attaque/déclin, glissando facultatif.
  function tone(o) {
    const t0 = ctx.currentTime + (o.at || 0);
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = o.type || "sine";
    osc.frequency.setValueAtTime(o.f, t0);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t0 + (o.glide || o.dur));
    if (o.detune) osc.detune.value = o.detune;
    const a = o.attack || 0.005, vol = o.vol == null ? 0.3 : o.vol;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    let node = osc;
    if (o.lp) { const f = ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = o.lp; osc.connect(f); node = f; }
    node.connect(g); g.connect(o.bus || bB);
    osc.start(t0); osc.stop(t0 + o.dur + 0.05);
  }

  // Souffle filtré : déchirure, whoosh, étincelles.
  function noise(o) {
    const t0 = ctx.currentTime + (o.at || 0);
    const src = ctx.createBufferSource(); src.buffer = noiseBuffer();
    src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = o.type || "bandpass"; f.Q.value = o.q || 1;
    f.frequency.setValueAtTime(o.f0, t0);
    if (o.f1) f.frequency.exponentialRampToValueAtTime(o.f1, t0 + o.dur);
    const g = ctx.createGain(), a = o.attack || 0.01, vol = o.vol == null ? 0.3 : o.vol;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    src.connect(f); f.connect(g); g.connect(o.bus || bB);
    src.start(t0, Math.random()); src.stop(t0 + o.dur + 0.05);
  }

  const N = (n) => 440 * Math.pow(2, (n - 69) / 12); // note MIDI -> Hz

  // ---------- Catalogue de sons ----------
  const SOUNDS = {
    // --- Interface ---
    tick(d) { tone({ f: 1900, to: 1100, dur: 0.05, vol: 0.28, type: "triangle", bus: bU, at: d }); },
    hover(d) { tone({ f: 2600, dur: 0.035, vol: 0.07, bus: bU, at: d }); },
    nav(d) { tone({ f: N(76), dur: 0.09, vol: 0.18, type: "triangle", bus: bU, at: d }); tone({ f: N(83), dur: 0.12, vol: 0.14, type: "triangle", bus: bU, at: d + 0.05 }); },
    open(d) { noise({ f0: 500, f1: 3500, dur: 0.22, vol: 0.16, q: 0.8, bus: bU, at: d }); tone({ f: N(72), to: N(84), dur: 0.2, vol: 0.12, type: "sine", bus: bU, at: d }); },
    close(d) { noise({ f0: 3000, f1: 400, dur: 0.18, vol: 0.12, q: 0.8, bus: bU, at: d }); },
    on(d) { tone({ f: N(79), dur: 0.1, vol: 0.2, type: "triangle", bus: bU, at: d }); tone({ f: N(86), dur: 0.14, vol: 0.18, type: "triangle", bus: bU, at: d + 0.06 }); },
    off(d) { tone({ f: N(86), dur: 0.1, vol: 0.18, type: "triangle", bus: bU, at: d }); tone({ f: N(79), dur: 0.14, vol: 0.16, type: "triangle", bus: bU, at: d + 0.06 }); },
    ok(d) { [76, 81, 88].forEach((n, i) => tone({ f: N(n), dur: 0.22, vol: 0.18, type: "triangle", bus: bU, at: d + i * 0.07 })); },
    error(d) { tone({ f: 180, to: 110, dur: 0.22, vol: 0.22, type: "sawtooth", lp: 900, bus: bU, at: d }); },

    // --- Boosters ---
    packHover(d) { tone({ f: N(88), dur: 0.25, vol: 0.06, attack: 0.08, bus: bB, at: d }); tone({ f: N(95), dur: 0.2, vol: 0.04, attack: 0.08, bus: bB, at: d + 0.04 }); },
    // Déchirure du sceau : crépitement + souffle qui monte + choc grave
    tear(d = 0) {
      noise({ f0: 300, f1: 7000, dur: 0.42, vol: 0.34, q: 1.4, attack: 0.02, at: d });
      for (let i = 0; i < 9; i++) noise({ f0: 2500 + Math.random() * 4000, dur: 0.035, vol: 0.2, q: 3, type: "highpass", at: d + 0.02 + i * 0.045 });
      tone({ f: 140, to: 38, dur: 0.5, vol: 0.5, at: d + 0.3 });
      tone({ f: N(60), to: N(72), dur: 0.35, vol: 0.1, type: "sawtooth", lp: 1800, at: d });
    },
    flip(d = 0) { noise({ f0: 900, f1: 5200, dur: 0.16, vol: 0.2, q: 0.9, attack: 0.03, at: d }); tone({ f: 300, to: 180, dur: 0.1, vol: 0.18, type: "triangle", at: d + 0.05 }); },
    ready(d) { [84, 91, 96].forEach((n, i) => tone({ f: N(n), dur: 0.5, vol: 0.2, type: "sine", at: d + i * 0.14, bus: bB })); },

    // --- Jingles de rareté ---
    common(d = 0) {
      tone({ f: N(76), dur: 0.35, vol: 0.28, type: "sine", at: d });
      tone({ f: N(83), dur: 0.3, vol: 0.14, type: "sine", at: d + 0.02 });
    },
    rare(d = 0) {
      [76, 83, 88].forEach((n, i) => tone({ f: N(n), dur: 0.55, vol: 0.26, type: "triangle", at: d + i * 0.08 }));
      noise({ f0: 6000, dur: 0.25, vol: 0.06, q: 2, type: "highpass", at: d + 0.1 });
    },
    epic(d = 0) {
      [64, 71, 76, 83, 88, 95].forEach((n, i) => {
        tone({ f: N(n), dur: 0.7, vol: 0.2, type: "triangle", at: d + i * 0.07 });
        tone({ f: N(n - 12), dur: 0.7, vol: 0.1, type: "sawtooth", lp: 1400, at: d + i * 0.07 });
      });
      noise({ f0: 500, f1: 6000, dur: 0.5, vol: 0.12, q: 1, attack: 0.3, at: d });
      tone({ f: 90, to: 45, dur: 0.6, vol: 0.4, at: d });
    },
    legendary(d = 0) {
      tone({ f: 60, to: 32, dur: 1.4, vol: 0.7, at: d });                                       // choc de reiatsu
      noise({ f0: 200, f1: 9000, dur: 0.7, vol: 0.28, q: 0.8, attack: 0.5, at: d });                // montée
      [60, 64, 67, 72, 76, 79, 84].forEach((n, i) => {                                           // accord éclatant
        tone({ f: N(n), dur: 1.8, vol: 0.16, type: "sawtooth", lp: 2600, detune: -6, at: d + 0.35 + i * 0.05 });
        tone({ f: N(n), dur: 1.8, vol: 0.12, type: "triangle", detune: 7, at: d + 0.35 + i * 0.05 });
      });
      for (let i = 0; i < 14; i++) tone({ f: N(96 + Math.floor(Math.random() * 14)), dur: 0.28, vol: 0.07, at: d + 0.5 + Math.random() * 1.2 }); // étincelles
    },
    mythic(d = 0) {
      tone({ f: 48, to: 24, dur: 2.0, vol: 0.8, at: d });                                        // séisme
      tone({ f: 96, to: 40, dur: 1.2, vol: 0.4, type: "sawtooth", lp: 600, at: d + 0.05 });
      noise({ f0: 120, f1: 12000, dur: 1.1, vol: 0.34, q: 0.7, attack: 0.8, at: d });            // montée géante
      [48, 55, 60, 67, 72, 76, 79, 84, 91].forEach((n, i) => {                                   // accord royal
        tone({ f: N(n), dur: 2.6, vol: 0.14, type: "sawtooth", lp: 3200, detune: -8, at: d + 0.7 + i * 0.06 });
        tone({ f: N(n), dur: 2.6, vol: 0.11, type: "triangle", detune: 9, at: d + 0.7 + i * 0.06 });
      });
      for (let i = 0; i < 26; i++) tone({ f: N(90 + Math.floor(Math.random() * 20)), dur: 0.32, vol: 0.06, at: d + 0.8 + Math.random() * 2 }); // pluie d'étoiles
    },
  };

  function play(name, delay) {
    const fn = SOUNDS[name];
    if (!fn || S.muted) return;
    const isUI = ["tick", "hover", "nav", "open", "close", "on", "off", "ok", "error"].includes(name);
    if (isUI && !S.uiSounds && !["on", "off", "ok", "error"].includes(name)) return;
    if (name === "ready" && !S.ready) return;
    if (!ensure()) return;
    try { fn(delay || 0); } catch (e) {}
  }

  // Joue le son d'une rareté (respecte l'option « jingles »).
  function reveal(rarity, delay) {
    if (!S.jingles) { play("flip", delay); return; }
    play("flip", delay);
    play(SOUNDS[rarity] ? rarity : "common", (delay || 0) + 0.22);
  }

  // Test d'un son depuis les réglages : joue même si l'option correspondante est coupée (sauf mute général).
  function preview(name, rarity) {
    if (S.muted) return;
    if (!ensure()) return;
    try { (SOUNDS[name] || SOUNDS.tick)(0); } catch (e) {}
  }

  window.XII = { Settings, Sound: { play, reveal, preview, ensure, names: Object.keys(SOUNDS) } };

  // ---------- Petits sons d'interface (délégation) ----------
  document.addEventListener("click", (e) => {
    if (e.target.closest("#nav a")) return play("nav");
    if (e.target.closest(".modal-x")) return play("close");
    if (e.target.closest(".btn, .chip, .theme-btn, .seg button, .preset, .player, label.file")) {
      if (e.target.closest("[data-nosound]")) return;
      play("tick");
    }
  }, true);
  let lastHover = null;
  document.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch") return;
    const el = e.target.closest && e.target.closest("#nav a, .btn, .chip, .card:not(.locked), .player, .theme-btn");
    if (el && el !== lastHover) { lastHover = el; if (S.uiSounds) play("hover"); }
    else if (!el) lastHover = null;
  });
})();
