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
}

export function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 2700);
}

/// Inventory overlay. `session` provides ui_state/ui_action via the wasm
/// Game (host applies directly; client sends C2H::UiAction to the host).
export class InventoryUI {
  constructor(session) {
    this.session = session;
    this.open = false;
    this.fuseFrom = null; // weapon index awaiting a material pick
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyI' || (e.code === 'Escape' && this.open)) {
        e.preventDefault();
        this.toggle();
      }
    });
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
    if (!state) {
      list.textContent = 'your pack is empty.';
      return;
    }

    // Character level header.
    const lvRow = document.createElement('div');
    lvRow.className = 'inv-row inv-level';
    lvRow.textContent = `LEVEL ${state.level} — ${state.xp_into}/${state.xp_need} XP — ${state.max_hp_hearts} HEARTS`;
    list.appendChild(lvRow);

    // Skills header.
    const skillsRow = document.createElement('div');
    skillsRow.className = 'inv-row inv-skills';
    skillsRow.textContent = state.skills
      .map((s) => `${s.name} ${s.level} (${s.xp}/${s.next})`)
      .join(' · ');
    list.appendChild(skillsRow);

    // Quest log.
    const activeQuests = state.quests.filter((q) => !q.done);
    if (activeQuests.length) {
      const header = document.createElement('div');
      header.className = 'inv-row';
      header.textContent = '— QUESTS —';
      list.appendChild(header);
      for (const q of activeQuests) {
        const row = document.createElement('div');
        row.className = 'inv-row';
        const name = document.createElement('span');
        name.className = 'inv-name';
        name.textContent = q.title;
        row.appendChild(name);
        const meta = document.createElement('span');
        meta.className = 'inv-meta';
        meta.textContent = q.objectives.join(' · ');
        meta.style.minWidth = 'auto';
        row.appendChild(meta);
        list.appendChild(row);
      }
    }

    // Campfire cooking section.
    if (state.near_fire) {
      const header = document.createElement('div');
      header.className = 'inv-row';
      header.textContent = '— CAMPFIRE —';
      list.appendChild(header);
      for (const r of state.recipes) {
        if (!r.level_ok && !r.can_make) continue;
        const row = document.createElement('div');
        row.className = 'inv-row';
        const name = document.createElement('span');
        name.className = 'inv-name';
        name.textContent = `${r.label} (${r.inputs.join(' + ')})`;
        row.appendChild(name);
        if (!r.level_ok) {
          const meta = document.createElement('span');
          meta.className = 'inv-meta';
          meta.textContent = `LV ${r.level}`;
          row.appendChild(meta);
        } else if (r.can_make) {
          row.appendChild(
            this.button('COOK', false, () => this.action({ action: 'cook', a: r.i })),
          );
        } else {
          const meta = document.createElement('span');
          meta.className = 'inv-meta';
          meta.textContent = 'need items';
          row.appendChild(meta);
        }
        list.appendChild(row);
      }
    }

    // Vendor shop section (when standing by a vendor NPC).
    const vendor = this.session.game.vendor_here(this.session.slot);
    if (vendor >= 0) {
      const shop = JSON.parse(this.session.game.shop_json(this.session.slot, vendor));
      if (shop) {
        const header = document.createElement('div');
        header.className = 'inv-row';
        header.textContent = `— ${shop.vendor} —`;
        list.appendChild(header);
        for (const s of shop.items) {
          const row = document.createElement('div');
          row.className = 'inv-row';
          const name = document.createElement('span');
          name.className = 'inv-name';
          name.textContent = s.qty > 1 ? `${s.label} x${s.qty}` : s.label;
          row.appendChild(name);
          const meta = document.createElement('span');
          meta.className = 'inv-meta';
          meta.textContent = `${s.price} shells`;
          row.appendChild(meta);
          if (s.affordable) {
            row.appendChild(
              this.button('BUY', false, () =>
                this.action({ action: 'buy', a: shop.npc, b: s.i }),
              ),
            );
          }
          list.appendChild(row);
        }
      }
    }

    for (const item of state.inventory) {
      const row = document.createElement('div');
      row.className = 'inv-row';

      const name = document.createElement('span');
      name.className = 'inv-name';
      name.textContent = item.label;
      if (item.fused) {
        const f = document.createElement('span');
        f.className = 'fused';
        f.textContent = ` +${item.fused}`;
        name.appendChild(f);
      }
      row.appendChild(name);

      const meta = document.createElement('span');
      meta.className = 'inv-meta';
      meta.textContent = ['sword', 'bow', 'shield', 'rod'].includes(item.kind)
        ? `${item.dur}/${item.max_dur}`
        : item.kind === 'food'
          ? `x${item.qty} (+${item.heal / 2}♥)`
          : `x${item.qty}`;
      row.appendChild(meta);

      if (this.fuseFrom !== null) {
        if (item.kind === 'material') {
          row.appendChild(
            this.button('FUSE THIS', false, () => {
              this.action({ action: 'fuse', a: this.fuseFrom, b: item.i });
              this.fuseFrom = null;
            }),
          );
        }
      } else {
        if (item.kind === 'sword') {
          row.appendChild(
            this.button('A', state.equip_a === item.i, () =>
              this.action({ action: 'equip_a', a: item.i }),
            ),
          );
        }
        if (['bow', 'shield', 'bomb', 'rod'].includes(item.kind)) {
          row.appendChild(
            this.button('B', state.equip_b === item.i, () =>
              this.action({ action: 'equip_b', a: item.i }),
            ),
          );
        }
        if (item.kind === 'food') {
          row.appendChild(
            this.button('EAT', false, () => this.action({ action: 'eat', a: item.i })),
          );
        }
        if (['sword', 'bow', 'shield'].includes(item.kind) && !item.fused) {
          row.appendChild(this.button('FUSE', false, () => {
            this.fuseFrom = item.i;
            this.render();
          }));
        }
      }
      list.appendChild(row);
    }
    if (this.fuseFrom !== null) {
      const hint = document.createElement('div');
      hint.className = 'inv-row';
      hint.textContent = 'pick a material to fuse →';
      list.prepend(hint);
    }
  }

  button(label, active, onClick) {
    const b = document.createElement('button');
    b.textContent = label;
    if (active) b.className = 'active';
    b.onclick = () => {
      onClick();
      // Re-render after the action lands: immediate for host, a beat
      // later for clients (round trip through the host).
      setTimeout(() => this.open && this.render(), 120);
    };
    return b;
  }

  action(obj) {
    this.session.sendUiAction(JSON.stringify(obj));
  }
}
