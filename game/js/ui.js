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
