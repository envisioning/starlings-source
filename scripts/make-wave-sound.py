"""Generate Resources/Sounds/wave.wav — a colleague waving at you.

Two short bell partials a major sixth apart, struck 90 ms apart and rising.
Deliberately smaller and brighter than the knock: a knock is somebody at a
door and asks to be answered, a wave is somebody catching your eye across a
room and asks for nothing. Rising rather than falling because a falling pair
reads as a dismissal, which is the opposite of the gesture.

Regenerate with `python3 scripts/make-wave-sound.py` if it is ever retuned.
"""
import math
import struct
import wave

RATE = 44100
LENGTH = 0.60
GAP = 0.090
# E6, then C#7 — a major sixth up. Each note is a fundamental plus two
# inharmonic partials, which is what keeps it a chime rather than a beep.
NOTES = [(1318.51, 0.86), (2217.46, 1.0)]
PARTIALS = [(1.0, 0.20, 1.00), (2.76, 0.13, 0.30), (5.40, 0.07, 0.12)]


def strike(frequency, frames):
    """One struck partial stack, `frames` long, peak-normalised to 1.0."""
    out = [0.0] * frames
    for index in range(frames):
        seconds = index / RATE
        sample = 0.0
        for ratio, tau, gain in PARTIALS:
            sample += gain * math.sin(2 * math.pi * frequency * ratio * seconds) * math.exp(-seconds / tau)
        # 2 ms fade-in: a chime that starts at full amplitude clicks.
        out[index] = sample * min(1.0, seconds / 0.002)
    peak = max(abs(value) for value in out) or 1.0
    return [value / peak for value in out]


total = int(LENGTH * RATE)
samples = [0.0] * total
for position, (frequency, gain) in enumerate(NOTES):
    offset = int(position * GAP * RATE)
    for index, value in enumerate(strike(frequency, total - offset)):
        samples[offset + index] += value * gain

peak = max(abs(value) for value in samples) or 1.0
# Quieter than the knock at 0.86. A wave that is as loud as somebody at the
# door has misrepresented itself.
frames = b"".join(
    struct.pack("<h", int(max(-1.0, min(1.0, value / peak * 0.58)) * 32767))
    for value in samples
)

with wave.open("Resources/Sounds/wave.wav", "wb") as handle:
    handle.setnchannels(1)
    handle.setsampwidth(2)
    handle.setframerate(RATE)
    handle.writeframes(frames)
print("wrote Resources/Sounds/wave.wav", len(frames), "bytes")
