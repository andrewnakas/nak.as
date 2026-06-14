// DOM chrome: main menu, status messages, party code display.
// Game-world UI (hearts, inventory) renders on the canvas; this file is
// only the HTML shell around it.

import { authUser, friends, login, logout, register } from './api.js';

const $ = (sel) => document.querySelector(sel);

function refreshAuthBox() {
  const user = authUser();
  $('#auth-form').style.display = user ? 'none' : 'flex';
  $('#auth-state').style.display = user ? 'flex' : 'none';
  $('#friends-box').style.display = user ? 'flex' : 'none';
  if (user) {
    $('#auth-who').textContent = `cloud saves on: ${user}`;
    refreshFriends();
  }
}

async function refreshFriends() {
  const list = $('#friends-list');
  try {
    const all = await friends.list();
    list.textContent = all.length ? '' : 'no friends yet — add one below';
    for (const f of all) {
      const row = document.createElement('div');
      row.className = 'frow';
      const label = document.createElement('span');
      label.textContent =
        f.status === 'friend' ? `${f.username} (lv ${f.level})`
        : f.status === 'sent' ? `${f.username} — request sent`
        : `${f.username} wants to be friends`;
      row.appendChild(label);
      if (f.status === 'incoming') {
        for (const [text, accept] of [['OK', true], ['NO', false]]) {
          const b = document.createElement('button');
          b.textContent = text;
          b.onclick = async () => {
            await friends.respond(f.username, accept).catch((e) => setStatus(e.message, true));
            refreshFriends();
          };
          row.appendChild(b);
        }
      }
      list.appendChild(row);
    }
  } catch {
    list.textContent = '';
  }
}

function wireAuth() {
  const doAuth = async (fn) => {
    const username = $('#auth-user').value.trim();
    const password = $('#auth-pass').value;
    try {
      setStatus('…');
      await fn(username, password);
      setStatus('');
      refreshAuthBox();
    } catch (err) {
      setStatus(err.message, true);
    }
  };
  $('#auth-login').onclick = () => doAuth(login);
  $('#auth-register').onclick = () => doAuth(register);
  $('#auth-logout').onclick = async () => {
    await logout().catch(() => {});
    refreshAuthBox();
  };
  for (const sel of ['#auth-user', '#auth-pass']) {
    $(sel).onkeydown = (e) => {
      if (e.key === 'Enter') $('#auth-login').click();
      e.stopPropagation();
    };
  }
  $('#friend-name').onkeydown = (e) => e.stopPropagation();
  $('#friend-add').onclick = async () => {
    const name = $('#friend-name').value.trim();
    if (!name) return;
    try {
      await friends.request(name);
      $('#friend-name').value = '';
      refreshFriends();
    } catch (err) {
      setStatus(err.message, true);
    }
  };
}

let authWired = false;

/// Title screen: pick a name, optionally log in, then ENTER WORLD. There is
/// no solo/host/join — entering always puts you in a shared peer-hosted world
/// (new characters start with the tutorial first).
export function showEnter() {
  return new Promise((resolve) => {
    const menu = $('#menu');
    menu.style.display = 'flex';
    setStatus('');
    if (!authWired) {
      wireAuth();
      authWired = true;
    }
    refreshAuthBox();

    const name = $('#menu-name');
    name.value = localStorage.getItem('naks_name') ?? '';

    const finish = () => {
      localStorage.setItem('naks_name', name.value.trim());
      menu.style.display = 'none';
      resolve({ name: name.value.trim() || 'NAK', forceLocal: false });
    };

    $('#menu-enter').onclick = finish;
    $('#menu-name').onkeydown = (e) => {
      if (e.key === 'Enter') finish();
      e.stopPropagation();
    };
  });
}

export function setStatus(text, isError = false) {
  const el = $('#status');
  el.textContent = text;
  el.style.color = isError ? '#e08080' : '';
}

/// Show which shared world you're in (and whether you're hosting it).
export function showWorld(code, isHost) {
  $('#party-code').textContent = code ? `world ${code}${isHost ? ' (host)' : ''}` : '';
  $('#party-list').textContent = '';
  hideConnecting();
}

/// A "connecting…" overlay over the canvas (so a not-yet-connected client
/// never shows a bare black screen).
export function showConnecting(text) {
  const el = $('#connecting');
  if (el) {
    el.textContent = text;
    el.style.display = 'flex';
  }
}

export function hideConnecting() {
  const el = $('#connecting');
  if (el) el.style.display = 'none';
}

/// Wire up the proximity-voice toggle button. `makeMesh` is an async factory
/// that builds (once) and returns the VoiceMesh — deferred so the first click
/// provides the user gesture getUserMedia + audio unlock both require.
/// States cycle: off -> live (mic on) -> muted (hear others, mic off) -> off.
/// Music on/off + volume, persisted via the Audio instance. Call once the
/// world starts (audio is unlocked by then).
export function installAudioControls(audio) {
  const wrap = $('#av-controls');
  if (wrap) wrap.hidden = false;
  const toggle = $('#music-toggle');
  const vol = $('#music-vol');
  if (toggle && !toggle._wired) {
    toggle._wired = true;
    const paint = () => toggle.classList.toggle('off', !!audio.musicMuted);
    toggle.addEventListener('click', () => {
      audio.setMusicMuted(!audio.musicMuted);
      paint();
    });
    paint();
  }
  if (vol && !vol._wired) {
    vol._wired = true;
    vol.value = String(Math.round((audio.musicVol ?? 1) * 100));
    vol.addEventListener('input', () => audio.setMusicVolume(vol.value / 100));
  }
}

export function installVoiceToggle(makeMesh, audio) {
  const btn = $('#voice-toggle');
  if (!btn || btn._wired) return;
  btn._wired = true;
  const wrap = $('#av-controls');
  if (wrap) wrap.hidden = false;
  let state = 'off'; // 'off' | 'live' | 'muted'
  let mesh = null;
  let statusTimer = null;

  const paint = () => {
    btn.classList.toggle('on', state === 'live');
    btn.classList.remove('error');
    if (state === 'off') {
      btn.textContent = '🎙 voice off';
    } else {
      // Show how many nearby players we're actually connected to, so it's
      // obvious whether voice linked up (vs. silently failing to connect).
      const n = mesh?.connectedCount?.() ?? 0;
      const tag = state === 'muted' ? '🔇 muted' : '🎙 voice';
      btn.textContent = n > 0 ? `${tag} · ${n}` : `${tag} · …`;
    }
  };
  // While live, refresh the connected-count badge so you can see links form.
  const startStatusPoll = () => {
    clearInterval(statusTimer);
    statusTimer = setInterval(paint, 1000);
  };

  btn.addEventListener('click', async () => {
    try {
      if (state === 'off') {
        btn.textContent = '🎙 …';
        if (!mesh) mesh = await makeMesh();
        await mesh.enable(); // prompts for mic the first time
        mesh.setMuted(false);
        state = 'live';
        // Duck the music while talking so it doesn't bleed into your mic / make
        // it hard to hear others (echo cancellation works far better quiet).
        audio?.duckMusic?.(true);
        startStatusPoll();
      } else if (state === 'live') {
        mesh.setMuted(true);
        state = 'muted';
      } else {
        mesh.stop();
        clearInterval(statusTimer);
        audio?.duckMusic?.(false);
        state = 'off';
      }
      paint();
    } catch (err) {
      // Mic denied or unavailable — surface it clearly and persistently.
      clearInterval(statusTimer);
      state = 'off';
      btn.classList.add('error');
      const name = err?.name || '';
      btn.textContent =
        name === 'NotAllowedError' ? '🎙 mic blocked' : name === 'NotFoundError' ? '🎙 no mic' : '🎙 voice error';
      toast('voice: ' + (err?.message || name || 'unavailable'));
    }
  });
  paint();
}

export function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 2700);
}

/// A toast with two buttons (e.g. a party invite). `cb(true)` on the yes
/// button, `cb(false)` on no or timeout. Auto-dismisses after ~15s (declines).
export function confirmToast(msg, yesLabel, noLabel, cb) {
  const el = document.createElement('div');
  el.className = 'toast confirm';
  const span = document.createElement('span');
  span.textContent = msg;
  el.appendChild(span);
  let done = false;
  const finish = (ok) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    el.remove();
    cb(ok);
  };
  for (const [label, ok] of [[yesLabel, true], [noLabel, false]]) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = () => finish(ok);
    el.appendChild(b);
  }
  const timer = setTimeout(() => finish(false), 15000);
  $('#toasts').appendChild(el);
}

/// Party roster panel: a 👥 toggle that opens a clickable list of everyone in
/// the world. Each non-self row offers INVITE (or shows a party badge with
/// WARP/FOLLOW for members) plus a LEAVE PARTY button when you're in one.
/// `cfg` provides accessors/actions from World. Returns a render() to call when
/// the roster or party set changes.
export function installPartyRoster(cfg) {
  const btn = $('#party-toggle');
  const panel = $('#party-panel');
  if (!btn || !panel) return () => {};
  const wrap = $('#av-controls');
  if (wrap) wrap.hidden = false;

  let open = false;
  if (!btn._wired) {
    btn._wired = true;
    btn.addEventListener('click', () => {
      open = !open;
      btn.classList.toggle('on', open);
      panel.hidden = !open;
      if (open) render();
    });
  }

  const render = () => {
    const inParty = cfg.party().size > 0;
    btn.textContent = inParty ? `👥 party · ${cfg.party().size + 1}` : '👥 party';
    if (!open) return;
    panel.textContent = '';
    const entries = cfg.roster();
    const others = entries.filter((e) => e.slot !== cfg.localSlot());
    if (!others.length) {
      const hint = document.createElement('div');
      hint.className = 'phint';
      hint.textContent = 'no one else here yet.';
      panel.appendChild(hint);
    }
    for (const e of others) {
      const member = cfg.party().has(e.slot);
      const row = document.createElement('div');
      row.className = 'prow';
      const name = document.createElement('span');
      name.className = member ? 'pname member' : 'pname';
      name.textContent = (member ? '★ ' : '') + e.name;
      row.appendChild(name);
      if (member) {
        const warp = document.createElement('button');
        warp.textContent = 'WARP';
        warp.onclick = () => cfg.warpTo(e.slot);
        row.appendChild(warp);
        const follow = document.createElement('button');
        const following = cfg.following() === e.slot;
        follow.textContent = 'FOLLOW';
        follow.classList.toggle('on', following);
        follow.onclick = () => {
          cfg.follow(e.slot);
          render();
        };
        row.appendChild(follow);
      } else {
        const id = cfg.slotToId(e.slot);
        const inv = document.createElement('button');
        inv.textContent = 'INVITE';
        inv.disabled = !id;
        inv.onclick = () => {
          if (!id) return;
          cfg.invite(id);
          toast(`invited ${e.name}`);
        };
        row.appendChild(inv);
      }
      panel.appendChild(row);
    }
    if (inParty) {
      const leave = document.createElement('button');
      leave.textContent = 'LEAVE PARTY';
      leave.onclick = () => {
        cfg.leave();
        render();
      };
      panel.appendChild(leave);
    }
  };
  return render;
}

/// The currently-active inventory overlay (last one constructed). The mobile
/// ☰ button toggles whichever this is, so it survives host migration.
let activeInventory = null;
export function toggleInventory() {
  activeInventory?.toggle();
}

/// Inventory overlay. `session` provides ui_state/ui_action via the wasm
/// Game (host applies directly; client sends C2H::UiAction to the host).
export class InventoryUI {
  constructor(session) {
    this.session = session;
    this.open = false;
    this.tab = 'items'; // 'items' | 'quests' | 'skills'
    this.fuseFrom = null; // weapon index awaiting a material pick
    this.attachFrom = null; // gear index awaiting a body-part pick
    this.cat = 'weapons'; // active category in the visual items grid
    this.sel = null; // selected inventory index (shown in the detail panel)
    activeInventory = this;

    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyI' || (e.code === 'Escape' && this.open)) {
        e.preventDefault();
        this.toggle();
      }
    });

    // Wire the tabs and close button once (idempotent across re-creation).
    $('#inv-close').onclick = () => this.toggle();
    for (const t of document.querySelectorAll('.inv-tab')) {
      t.onclick = () => {
        this.tab = t.dataset.tab;
        this.fuseFrom = null;
        this.attachFrom = null;
        this.render();
      };
    }
  }

  toggle() {
    this.open = !this.open;
    this.fuseFrom = null;
    this.attachFrom = null;
    $('#inv').style.display = this.open ? 'flex' : 'none';
    this.session.input.suppressed = this.open;
    if (this.open) this.render();
  }

  render() {
    const state = JSON.parse(this.session.game.ui_state(this.session.slot));
    const list = $('#inv-list');
    list.textContent = '';
    for (const t of document.querySelectorAll('.inv-tab')) {
      t.classList.toggle('active', t.dataset.tab === this.tab);
    }
    if (!state) {
      list.appendChild(this._empty('your pack is empty.'));
      return;
    }
    if (this.tab === 'items') this._renderItems(list, state);
    else if (this.tab === 'quests') this._renderQuests(list, state);
    else this._renderSkills(list, state);
  }

  // ---- ITEMS tab: gear/consumables, plus campfire + vendor when nearby ----
  _renderItems(list, state) {
    if (this.fuseFrom !== null) {
      list.appendChild(this._section('PICK A MATERIAL TO CRAFT WITH'));
      const mats = state.inventory.filter((it) => it.kind === 'material');
      if (!mats.length) list.appendChild(this._empty('no materials to craft with.'));
      for (const item of mats) {
        const row = this._itemRow(item);
        row.appendChild(
          this.button('CRAFT', false, () => {
            this.action({ action: 'fuse', a: this.fuseFrom, b: item.i });
            this.fuseFrom = null;
          }),
        );
        list.appendChild(row);
      }
      list.appendChild(
        this.button('CANCEL', false, () => {
          this.fuseFrom = null;
          this.render();
        }),
      );
      return;
    }

    if (this.attachFrom !== null) {
      list.appendChild(this._section('PICK A BODY PART TO ATTACH'));
      const parts = state.inventory.filter((it) => it.kind === 'bodypart');
      if (!parts.length) list.appendChild(this._empty('no body parts — hunt for some.'));
      for (const item of parts) {
        const row = this._itemRow(item);
        row.appendChild(
          this.button('ATTACH', false, () => {
            this.action({ action: 'attach', a: this.attachFrom, b: item.i });
            this.attachFrom = null;
          }),
        );
        list.appendChild(row);
      }
      list.appendChild(
        this.button('CANCEL', false, () => {
          this.attachFrom = null;
          this.render();
        }),
      );
      return;
    }

    // Campfire cooking (only when standing by a fire).
    if (state.near_fire) {
      const makeable = state.recipes.filter((r) => r.level_ok || r.can_make);
      if (makeable.length) {
        list.appendChild(this._section('CAMPFIRE'));
        for (const r of makeable) {
          const row = document.createElement('div');
          row.className = 'inv-row';
          row.appendChild(this._icon(r.sprite));
          row.appendChild(this._name(r.label, `(${r.inputs.join(' + ')})`));
          if (!r.level_ok) row.appendChild(this._meta(`LV ${r.level}`));
          else if (r.can_make)
            row.appendChild(this.button('COOK', false, () => this.action({ action: 'cook', a: r.i })));
          else row.appendChild(this._meta('need items'));
          list.appendChild(row);
        }
      }
    }

    // Vendor shop (only when standing by a vendor).
    const vendor = this.session.game.vendor_here(this.session.slot);
    if (vendor >= 0) {
      const shop = JSON.parse(this.session.game.shop_json(this.session.slot, vendor));
      if (shop) {
        list.appendChild(this._section(`${shop.vendor} — ${shop.shells} SHELLS`));
        for (const s of shop.items) {
          const row = document.createElement('div');
          row.className = 'inv-row';
          row.appendChild(this._icon(s.sprite));
          row.appendChild(this._name(s.qty > 1 ? `${s.label} x${s.qty}` : s.label));
          row.appendChild(this._meta(`${s.price} shells`));
          if (s.affordable)
            row.appendChild(this.button('BUY', false, () => this.action({ action: 'buy', a: shop.npc, b: s.i })));
          list.appendChild(row);
        }
      }
    }

    // The pack itself — a BotW-style visual grid grouped by category, with a
    // detail panel for the selected item.
    if (!state.inventory.length) {
      list.appendChild(this._section('PACK'));
      list.appendChild(this._empty('empty — punch a tree to break off a stick.'));
      return;
    }
    this._renderPackGrid(list, state);
  }

  /// Categories for the visual grid. `match` decides which items fall in each;
  /// order defines the chip order.
  static get CATEGORIES() {
    return [
      { key: 'weapons', label: 'WEAPONS', match: (it) => it.kind === 'sword' },
      { key: 'gear', label: 'BOWS & SHIELDS', match: (it) => it.kind === 'bow' || it.kind === 'shield' },
      { key: 'tools', label: 'TOOLS', match: (it) => it.kind === 'rod' || it.kind === 'bomb' || it.kind === 'arrow' },
      { key: 'materials', label: 'MATERIALS', match: (it) => it.kind === 'material' },
      { key: 'parts', label: 'BODY PARTS', match: (it) => it.kind === 'bodypart' },
      { key: 'food', label: 'FOOD', match: (it) => it.kind === 'food' },
    ];
  }

  _renderPackGrid(list, state) {
    const cats = InventoryUI.CATEGORIES;
    const inCat = (cat, it) => cats.find((c) => c.key === cat)?.match(it);

    // Category chips (only those with items; counts shown). Keep `this.cat`
    // valid — fall back to the first non-empty category.
    const nonEmpty = cats.filter((c) => state.inventory.some((it) => c.match(it)));
    if (!nonEmpty.some((c) => c.key === this.cat)) this.cat = nonEmpty[0]?.key ?? 'weapons';

    const chips = document.createElement('div');
    chips.className = 'inv-cats';
    for (const c of nonEmpty) {
      const n = state.inventory.filter((it) => c.match(it)).length;
      const chip = document.createElement('button');
      chip.className = 'inv-cat' + (c.key === this.cat ? ' active' : '');
      chip.innerHTML = `${c.label} <span class="badge-n">${n}</span>`;
      chip.onclick = () => {
        this.cat = c.key;
        this.sel = null;
        this.render();
      };
      chips.appendChild(chip);
    }
    list.appendChild(chips);

    // The icon grid for the active category.
    const items = state.inventory.filter((it) => inCat(this.cat, it));
    const grid = document.createElement('div');
    grid.className = 'inv-grid';
    // Default selection to the first item in the category if nothing valid.
    if (!items.some((it) => it.i === this.sel)) this.sel = items[0]?.i ?? null;
    for (const item of items) {
      grid.appendChild(this._cell(item, state));
    }
    list.appendChild(grid);

    // Detail panel for the selected item.
    const sel = state.inventory.find((it) => it.i === this.sel);
    if (sel) list.appendChild(this._detail(sel, state));
  }

  /// One icon tile in the grid, with qty / durability / equipped / mod badges.
  _cell(item, state) {
    const cell = document.createElement('div');
    cell.className = 'inv-cell';
    if (item.i === this.sel) cell.classList.add('selected');
    const equipped = state.equip_a === item.i || state.equip_b === item.i;
    if (equipped) cell.classList.add('equipped');

    const img = document.createElement('img');
    img.src = this.session.renderer.spriteIcon(item.sprite, 3);
    cell.appendChild(img);

    // Equipped slot badge (A / B).
    if (state.equip_a === item.i) cell.appendChild(this._badge('slotbadge', 'A'));
    else if (state.equip_b === item.i) cell.appendChild(this._badge('slotbadge', 'B'));

    // A "+"/"«»" mod badge when crafted or has a body part attached.
    if (item.fused || item.attached) cell.appendChild(this._badge('modbadge', item.attached ? '✦' : '+'));

    // Stack count for consumables/materials; durability bar for gear.
    const gear = ['sword', 'bow', 'shield', 'rod'].includes(item.kind);
    if (gear && item.max_dur) {
      const bar = document.createElement('div');
      bar.className = 'durbar';
      const fill = document.createElement('span');
      fill.style.width = `${Math.max(0, Math.min(100, (item.dur / item.max_dur) * 100))}%`;
      bar.appendChild(fill);
      cell.appendChild(bar);
    } else if (item.qty > 1) {
      const qty = document.createElement('span');
      qty.className = 'qty';
      qty.textContent = `×${item.qty}`;
      cell.appendChild(qty);
    }

    cell.onclick = () => {
      this.sel = item.i;
      this.render();
    };
    return cell;
  }

  _badge(cls, text) {
    const b = document.createElement('span');
    b.className = cls;
    b.textContent = text;
    return b;
  }

  /// The detail panel: big icon, name, stats line, and the item's actions.
  _detail(item, state) {
    const panel = document.createElement('div');
    panel.className = 'inv-detail';

    const icon = document.createElement('img');
    icon.className = 'dicon';
    icon.src = this.session.renderer.spriteIcon(item.sprite, 4);
    panel.appendChild(icon);

    const body = document.createElement('div');
    body.className = 'dbody';
    const name = document.createElement('div');
    name.className = 'dname';
    name.textContent = item.label;
    body.appendChild(name);

    // Stats / mods line.
    const bits = [];
    const gear = ['sword', 'bow', 'shield', 'rod'].includes(item.kind);
    if (gear) bits.push(`durability ${item.dur}/${item.max_dur}`);
    if (item.kind === 'food') bits.push(`heals ${item.heal / 2}♥`);
    if (item.qty > 1) bits.push(`×${item.qty}`);
    if (item.fused) bits.push(`crafted: <span class="tag">${item.fused}</span>`);
    if (item.attached) bits.push(`attached: <span class="tag">${item.attached}</span>`);
    const sub = document.createElement('div');
    sub.className = 'dsub';
    sub.innerHTML = bits.join(' · ') || '—';
    body.appendChild(sub);

    const actions = document.createElement('div');
    actions.className = 'dactions';
    this._fillActions(actions, item, state);
    body.appendChild(actions);
    panel.appendChild(body);
    return panel;
  }

  /// Build the action buttons for the detail panel (equip / eat / craft /
  /// attach / detach), matching the item's kind.
  _fillActions(box, item, state) {
    if (item.kind === 'sword')
      box.appendChild(
        this.button(state.equip_a === item.i ? 'EQUIPPED (A)' : 'EQUIP (A)', state.equip_a === item.i, () =>
          this.action({ action: 'equip_a', a: item.i }),
        ),
      );
    if (['bow', 'shield', 'bomb', 'rod'].includes(item.kind))
      box.appendChild(
        this.button(state.equip_b === item.i ? 'EQUIPPED (B)' : 'EQUIP (B)', state.equip_b === item.i, () =>
          this.action({ action: 'equip_b', a: item.i }),
        ),
      );
    if (item.kind === 'food')
      box.appendChild(this.button('EAT', false, () => this.action({ action: 'eat', a: item.i })));
    if (['sword', 'bow', 'shield'].includes(item.kind) && !item.fused)
      box.appendChild(
        this.button('CRAFT', false, () => {
          this.fuseFrom = item.i;
          this.render();
        }),
      );
    if (['sword', 'bow', 'shield'].includes(item.kind)) {
      if (item.attached)
        box.appendChild(this.button('DETACH', false, () => this.action({ action: 'detach', a: item.i })));
      else
        box.appendChild(
          this.button('ATTACH', false, () => {
            this.attachFrom = item.i;
            this.render();
          }),
        );
    }
  }

  _itemRow(item, state) {
    const row = document.createElement('div');
    row.className = 'inv-row';
    row.appendChild(this._icon(item.sprite));

    const sub = [item.fused ? `+${item.fused}` : '', item.attached ? `«${item.attached}»` : '']
      .filter(Boolean)
      .join(' ');
    row.appendChild(this._name(item.label, sub, true));

    const meta = ['sword', 'bow', 'shield', 'rod'].includes(item.kind)
      ? `${item.dur}/${item.max_dur}`
      : item.kind === 'food'
        ? `x${item.qty}  +${item.heal / 2}♥`
        : `x${item.qty}`;
    row.appendChild(this._meta(meta));

    if (!state) return row; // fuse-picker rows pass no state

    if (item.kind === 'sword')
      row.appendChild(
        this.button('A', state.equip_a === item.i, () => this.action({ action: 'equip_a', a: item.i })),
      );
    if (['bow', 'shield', 'bomb', 'rod'].includes(item.kind))
      row.appendChild(
        this.button('B', state.equip_b === item.i, () => this.action({ action: 'equip_b', a: item.i })),
      );
    if (item.kind === 'food')
      row.appendChild(this.button('EAT', false, () => this.action({ action: 'eat', a: item.i })));
    if (['sword', 'bow', 'shield'].includes(item.kind) && !item.fused)
      row.appendChild(
        this.button('CRAFT', false, () => {
          this.fuseFrom = item.i;
          this.render();
        }),
      );
    // Body-part attachments: swappable, so always offer attach/detach on gear.
    // Weapons + shield only (rods are utility items, not stat carriers).
    if (['sword', 'bow', 'shield'].includes(item.kind)) {
      if (item.attached)
        row.appendChild(this.button('DETACH', false, () => this.action({ action: 'detach', a: item.i })));
      else
        row.appendChild(
          this.button('ATTACH', false, () => {
            this.attachFrom = item.i;
            this.render();
          }),
        );
    }
    return row;
  }

  // ---- QUESTS tab ----
  _renderQuests(list, state) {
    const active = state.quests.filter((q) => !q.done);
    const done = state.quests.filter((q) => q.done);
    if (!state.quests.length) {
      list.appendChild(this._empty('no quests yet — talk to the townsfolk.'));
      return;
    }
    if (active.length) {
      list.appendChild(this._section('ACTIVE'));
      for (const q of active) list.appendChild(this._questRow(q));
    }
    if (done.length) {
      list.appendChild(this._section('COMPLETED'));
      for (const q of done) list.appendChild(this._questRow(q, true));
    }
  }

  _questRow(q, complete) {
    const row = document.createElement('div');
    row.className = 'inv-row';
    const name = document.createElement('div');
    name.className = 'inv-name';
    const title = document.createElement('div');
    title.textContent = q.title + (complete ? ' ✓' : '');
    title.style.color = complete ? 'var(--gb-light)' : '';
    name.appendChild(title);
    if (!complete) {
      const obj = document.createElement('div');
      obj.style.fontSize = '10px';
      obj.style.color = '#8c9c84';
      obj.textContent = q.objectives.join(' · ');
      name.appendChild(obj);
    }
    row.appendChild(name);
    return row;
  }

  // ---- SKILLS tab ----
  _renderSkills(list, state) {
    list.appendChild(this._section('CHARACTER'));
    const lv = document.createElement('div');
    lv.className = 'inv-row inv-level';
    lv.textContent = `LEVEL ${state.level}`;
    list.appendChild(lv);
    const xp = document.createElement('div');
    xp.className = 'inv-row inv-skills';
    xp.textContent = `${state.xp_into} / ${state.xp_need} XP to next · ${state.max_hp_hearts} hearts`;
    list.appendChild(xp);

    list.appendChild(this._section('SKILLS'));
    for (const s of state.skills) {
      const row = document.createElement('div');
      row.className = 'inv-row inv-skills';
      row.textContent = `${s.name}  LV ${s.level}  (${s.xp}/${s.next})`;
      list.appendChild(row);
    }
  }

  // ---- small builders ----
  _icon(sprite) {
    const img = document.createElement('img');
    img.className = 'inv-icon';
    img.src = this.session.renderer.spriteIcon(sprite);
    return img;
  }

  _name(label, sub = '', fused = false) {
    const span = document.createElement('span');
    span.className = 'inv-name';
    span.textContent = label;
    if (sub) {
      const f = document.createElement('span');
      f.className = fused ? 'fused' : '';
      f.style.color = '#8c9c84';
      f.style.fontSize = '10px';
      f.textContent = ` ${sub}`;
      span.appendChild(f);
    }
    return span;
  }

  _meta(text) {
    const span = document.createElement('span');
    span.className = 'inv-meta';
    span.textContent = text;
    return span;
  }

  _section(text) {
    const d = document.createElement('div');
    d.className = 'inv-section';
    d.textContent = text;
    return d;
  }

  _empty(text) {
    const d = document.createElement('div');
    d.className = 'inv-empty';
    d.textContent = text;
    return d;
  }

  button(label, active, onClick) {
    const b = document.createElement('button');
    b.textContent = label;
    if (active) b.className = 'active';
    b.onclick = () => {
      onClick();
      // Re-render after the action lands: immediate for host, a beat later
      // for clients (round trip through the host).
      setTimeout(() => this.open && this.render(), 140);
    };
    return b;
  }

  action(obj) {
    this.session.sendUiAction(JSON.stringify(obj));
  }
}
