// Party system: a small peer-to-peer group layered on the signaling socket.
//
// Members are identified by their signaling id (stable for the session). The
// party set is shared by gossip: whenever it changes, every member is sent the
// full id list, so the group converges without a central owner. Party state
// feeds three game systems via the World: always-on voice (setAlwaysHear),
// minimap party-coloring, and warp/follow to a member.
//
// Wire protocol (relayed by the RoomDO 'party' passthrough; `from`/`name` are
// stamped by the DO):
//   { t:'party', to, kind:'invite' }                    A -> B: join my party?
//   { t:'party', to, kind:'accept', members:[ids...] }  B -> A: yes; here's us
//   { t:'party', to, kind:'decline' }                   B -> A: no thanks
//   { t:'party', to, kind:'sync',   members:[ids...] }  any -> member: roster
//   { t:'party', to, kind:'leave' }                     X -> member: I'm out

export class Party {
  /// signaling: the Signaling socket. selfId: our stable id. onChange(): called
  /// whenever membership changes (World re-derives voice/minimap from it).
  /// nameOf(id): best-effort display name for a toast. onInvite({id,name}): the
  /// UI prompt shown when someone invites us (returns nothing; it should call
  /// accept(id) / decline(id)).
  constructor({ signaling, selfId, onChange, onInvite, nameOf }) {
    this.signaling = signaling;
    this.selfId = selfId;
    this.onChange = onChange ?? (() => {});
    this.onInvite = onInvite ?? (() => {});
    this.nameOf = nameOf ?? (() => 'player');
    // Member signaling ids (excludes self; self is implicitly a member when
    // the set is non-empty). Pending = invites we've sent, awaiting a reply.
    this.members = new Set();
    this.pending = new Set();

    this._onMsg = (m) => this._handle(m);
    signaling.on('party', this._onMsg);
    // If a member's signaling link drops, prune them from the party.
    this._onLeft = (m) => {
      if (this.members.delete(m.id)) {
        this.pending.delete(m.id);
        this._changed();
      }
    };
    signaling.on('peer-left', this._onLeft);
  }

  dispose() {
    this.signaling.off?.('party', this._onMsg);
    this.signaling.off?.('peer-left', this._onLeft);
  }

  /// True if we're in a party with anyone.
  get active() {
    return this.members.size > 0;
  }

  /// The full member id list including self (the on-wire representation).
  _roster() {
    return [this.selfId, ...this.members];
  }

  _send(to, kind, extra = {}) {
    this.signaling.send({ t: 'party', to, kind, ...extra });
  }

  _changed() {
    this.onChange();
  }

  /// Adopt a roster received from a peer (merge, dropping self). Returns true
  /// if anything new was added (the caller re-gossips on change so knowledge
  /// propagates epidemically; it converges because no-new-adds stops the relay).
  _adopt(ids) {
    let changed = false;
    for (const id of ids) {
      if (id !== this.selfId && !this.members.has(id)) {
        this.members.add(id);
        changed = true;
      }
    }
    if (changed) this._changed();
    return changed;
  }

  /// Push our current roster to every member (after we add/remove someone).
  _gossip() {
    const members = this._roster();
    for (const id of this.members) this._send(id, 'sync', { members });
  }

  // ---- outgoing actions (called by the UI) ----

  invite(id) {
    if (id === this.selfId || this.members.has(id) || this.pending.has(id)) return;
    this.pending.add(id);
    this._send(id, 'invite');
    // Pending invites time out so a dropped/ignored invite can be re-sent later.
    setTimeout(() => this.pending.delete(id), 20000);
  }

  accept(id) {
    // Join the inviter: add them, take their roster on the incoming accept's
    // payload (handled in _handle), and tell everyone the merged set.
    this.members.add(id);
    this._send(id, 'accept', { members: this._roster() });
    this._gossip();
    this._changed();
  }

  decline(id) {
    this._send(id, 'decline');
  }

  leave() {
    for (const id of this.members) this._send(id, 'leave');
    this.members.clear();
    this.pending.clear();
    this._changed();
  }

  // ---- incoming ----

  _handle(m) {
    if (!m.from || m.from === this.selfId) return;
    switch (m.kind) {
      case 'invite':
        // Surface a prompt; the UI decides accept/decline.
        this.onInvite({ id: m.from, name: m.name ?? this.nameOf(m.from) });
        break;
      case 'accept':
        // They joined us. Add them + merge their roster, then gossip so the
        // whole group (old members + the newcomer) converges.
        this.pending.delete(m.from);
        this.members.add(m.from);
        if (Array.isArray(m.members)) this._adopt(m.members);
        this._gossip();
        this._changed();
        break;
      case 'decline':
        this.pending.delete(m.from);
        break;
      case 'sync':
        if (Array.isArray(m.members)) {
          // Merge in the sender + their roster. (We never shrink from a sync to
          // avoid a stale message evicting someone; explicit 'leave' removes.)
          // Re-gossip when we learned someone new so the knowledge spreads to
          // members only we can reach; it converges once no sync adds anyone.
          const added = !this.members.has(m.from);
          this.members.add(m.from);
          const adopted = this._adopt(m.members);
          if (added || adopted) {
            this._gossip();
            this._changed();
          }
        }
        break;
      case 'leave':
        if (this.members.delete(m.from)) {
          this.pending.delete(m.from);
          this._changed();
        }
        break;
    }
  }
}
