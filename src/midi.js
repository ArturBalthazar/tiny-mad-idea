/**
 * Minimal MIDI Format 0 parser.
 * Returns an array of note-on events with time in seconds.
 */

function readVarLen(data, pos) {
  let value = 0;
  let byte;
  do {
    byte = data.getUint8(pos++);
    value = (value << 7) | (byte & 0x7f);
  } while (byte & 0x80);
  return { value, pos };
}

export function parseMidi(arrayBuffer) {
  const data = new DataView(arrayBuffer);

  // Header
  const ticksPerBeat = data.getUint16(12);

  // Track 0
  const trackLen = data.getUint32(18);
  let pos = 22;
  const end = pos + trackLen;

  let lastStatus = 0;
  let totalTicks = 0;
  const notes = [];
  const tempoMap = [{ tick: 0, tempo: 500000 }]; // default 120 BPM

  while (pos < end) {
    const delta = readVarLen(data, pos);
    pos = delta.pos;
    totalTicks += delta.value;

    let status = data.getUint8(pos);
    if (status < 0x80) {
      // running status
      status = lastStatus;
    } else {
      pos++;
      lastStatus = status;
    }

    const type = status & 0xf0;

    if (status === 0xff) {
      // Meta event
      const metaType = data.getUint8(pos++);
      const metaLen = readVarLen(data, pos);
      pos = metaLen.pos;

      if (metaType === 0x51 && metaLen.value === 3) {
        const tempo =
          (data.getUint8(pos) << 16) |
          (data.getUint8(pos + 1) << 8) |
          data.getUint8(pos + 2);
        tempoMap.push({ tick: totalTicks, tempo });
      }
      pos += metaLen.value;
    } else if (type === 0x90) {
      const note = data.getUint8(pos++);
      const vel = data.getUint8(pos++);
      if (vel > 0) {
        notes.push({ tick: totalTicks, note, velocity: vel });
      }
    } else if (type === 0x80) {
      pos += 2;
    } else if (type === 0xb0 || type === 0xa0 || type === 0xe0) {
      pos += 2;
    } else if (type === 0xc0 || type === 0xd0) {
      pos += 1;
    } else if (type === 0xf0 || type === 0xf7) {
      // SysEx
      const sysLen = readVarLen(data, pos);
      pos = sysLen.pos + sysLen.value;
    }
  }

  // Convert ticks to seconds using the tempo map
  function tickToSeconds(tick) {
    let time = 0;
    let prevTick = 0;
    let currentTempo = tempoMap[0].tempo;

    for (let i = 1; i < tempoMap.length; i++) {
      if (tempoMap[i].tick >= tick) break;
      time +=
        ((tempoMap[i].tick - prevTick) / ticksPerBeat) *
        (currentTempo / 1_000_000);
      prevTick = tempoMap[i].tick;
      currentTempo = tempoMap[i].tempo;
    }
    time += ((tick - prevTick) / ticksPerBeat) * (currentTempo / 1_000_000);
    return time;
  }

  const result = notes.map((n) => ({
    time: tickToSeconds(n.tick),
    note: n.note,
    velocity: n.velocity,
  }));

  const lastTick = notes.length > 0 ? notes[notes.length - 1].tick : 0;
  const duration = tickToSeconds(lastTick) + 1; // +1s buffer

  return { notes: result, duration };
}
