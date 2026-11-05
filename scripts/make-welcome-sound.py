"""Generate Resources/Sounds/welcome.wav — the room noticing you arrive.

One warm note with a fifth above it, swelling in over 40 ms rather than being
struck. Lower, rounder and slower than the wave on purpose: three sounds ship
in this app and each has to be recognisable before it finishes. A knock is
somebody at your door, a wave is somebody catching your eye, and this is the
only one that is not another person at all — it is the room, so it has no
transient and nothing to answer.

Regenerate with `python3 scripts/make-welcome-sound.py` if it is ever retuned.
"""
import math
import struct
import wave

RATE = 44100
LENGTH = 0.85
# A4 and the E5 above it. A fifth is the least eventful consonance there is,
# which is what "you are here" should sound like.
NOTES = [(440.00, 1.00), (659.25, 0.62)]
SWELL = 0.040
DECAY = 0.34

total = int(LENGTH * RATE)
samples = [0.0] * total
for frequency, gain in NOTES:
    for index in range(total):
        seconds = index / RATE
        # Swell in, then decay — no strike, so the ear reads it as the room
        # rather than as an object being hit.
        envelope = min(1.0, seconds / SWELL) * math.exp(-max(0.0, seconds - SWELL) / DECAY)
        # A touch of the octave keeps it from sounding like a test tone.
        voice = math.sin(2 * math.pi * frequency * seconds) \
            + 0.18 * math.sin(2 * math.pi * frequency * 2 * seconds)
        samples[index] += voice * envelope * gain

peak = max(abs(value) for value in samples) or 1.0
frames = b"".join(
    struct.pack("<h", int(max(-1.0, min(1.0, value / peak * 0.50)) * 32767))
    for value in samples
)

with wave.open("Resources/Sounds/welcome.wav", "wb") as handle:
    handle.setnchannels(1)
    handle.setsampwidth(2)
    handle.setframerate(RATE)
    handle.writeframes(frames)
print("wrote Resources/Sounds/welcome.wav", len(frames), "bytes")
