// DOM chrome: main menu, status messages, party code display.
// Game-world UI (hearts, inventory) renders on the canvas; this file is
// only the HTML shell around it.

const $ = (sel) => document.querySelector(sel);

export function showMenu() {
  return new Promise((resolve) => {
    const menu = $('#menu');
    menu.style.display = 'flex';
    setStatus('');

    const name = $('#menu-name');
    name.value = localStorage.getItem('naks_name') ?? '';

    const finish = (choice) => {
      localStorage.setItem('naks_name', name.value.trim());
      menu.style.display = 'none';
      resolve({ ...choice, name: name.value.trim() || 'NAK' });
    };

    $('#menu-solo').onclick = () => finish({ mode: 'solo' });
    $('#menu-host').onclick = () => finish({ mode: 'host' });
    $('#menu-join').onclick = () => {
      const code = $('#menu-code').value.trim().toUpperCase();
      if (!/^[A-Z2-9]{5}$/.test(code)) {
        setStatus('enter the 5-letter party code', true);
        return;
      }
      finish({ mode: 'join', code });
    };
    $('#menu-code').onkeydown = (e) => {
      if (e.key === 'Enter') $('#menu-join').click();
      e.stopPropagation(); // don't move the player while typing
    };
    $('#menu-name').onkeydown = (e) => e.stopPropagation();
  });
}

export function setStatus(text, isError = false) {
  const el = $('#status');
  el.textContent = text;
  el.style.color = isError ? '#e08080' : '';
}

export function showPartyCode(code) {
  $('#party-code').textContent = code ? `party code: ${code}` : '';
}

export function showPartyList(members) {
  $('#party-list').textContent = members.length > 1
    ? members.map((m) => m.name).join(' · ')
    : '';
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
