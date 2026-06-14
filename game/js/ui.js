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
export function installVoiceToggle(makeMesh) {
  const btn = $('#voice-toggle');
  if (!btn || btn._wired) return;
  btn._wired = true;
  btn.hidden = false;
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
        startStatusPoll();
      } else if (state === 'live') {
        mesh.setMuted(true);
        state = 'muted';
      } else {
        mesh.stop();
        clearInterval(statusTimer);
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
        this.render();
      };
    }
  }

  toggle() {
    this.open = !this.open;
    this.fuseFrom = null;
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
      list.appendChild(this._section('PICK A MATERIAL TO FUSE'));
      const mats = state.inventory.filter((it) => it.kind === 'material');
      if (!mats.length) list.appendChild(this._empty('no materials to fuse.'));
      for (const item of mats) {
        const row = this._itemRow(item);
        row.appendChild(
          this.button('FUSE', false, () => {
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

    // The pack itself.
    list.appendChild(this._section('PACK'));
    if (!state.inventory.length) {
      list.appendChild(this._empty('empty — punch a tree to break off a stick.'));
      return;
    }
    for (const item of state.inventory) {
      const row = this._itemRow(item, state);
      list.appendChild(row);
    }
  }

  _itemRow(item, state) {
    const row = document.createElement('div');
    row.className = 'inv-row';
    row.appendChild(this._icon(item.sprite));

    const sub = item.fused ? `+${item.fused}` : '';
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
        this.button('FUSE', false, () => {
          this.fuseFrom = item.i;
          this.render();
        }),
      );
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
