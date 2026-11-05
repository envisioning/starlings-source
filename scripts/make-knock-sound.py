"""Generate Resources/Sounds/knock.wav — two knuckle raps on a wooden door.

Physical model, not a sample: each rap is a click transient (band-limited
noise, 3 ms) exciting three damped resonances of a door panel. Two raps,
185 ms apart, because that is what "knock knock" is. Regenerate with
`python3 scripts/make-knock-sound.py` if the sound is ever retuned.
"""
import math
import random
import struct
import wave

RATE = 44100
LENGTH = 0.46
GAP = 0.185
# Panel modes: fundamental thud, the woody body, and the knuckle click.
MODES = [(168.0, 0.055, 1.00), (395.0, 0.038, 0.55), (930.0, 0.016, 0.22)]

random.seed(7)


def rap(frames):
    """One knuckle rap, `frames` long, peak-normalised to 1.0."""
    out = [0.0] * frames
    # 3 ms of noise is the knuckle hitting; everything after it is the door.
    click = int(0.003 * RATE)
    previous = 0.0
    for index in range(frames):
        seconds = index / RATE
        sample = 0.0
        for frequency, tau, gain in MODES:
            sample += gain * math.sin(2 * math.pi * frequency * seconds) * math.exp(-seconds / tau)
        if index < click:
            noise = random.uniform(-1.0, 1.0) * (1.0 - index / click)
            # One-pole lowpass: an unfiltered burst reads as a snare, not wood.
            previous = previous * 0.72 + noise * 0.28
            sample += previous * 2.6
        # 1.5 ms fade-in keeps the attack from clipping into a DC step.
        attack = min(1.0, seconds / 0.0015)
        out[index] = sample * attack
    peak = max(abs(value) for value in out) or 1.0
    return [value / peak for value in out]


total = int(LENGTH * RATE)
samples = [0.0] * total
single = rap(int(0.26 * RATE))
# The second rap lands a touch harder — nobody knocks twice identically, and
# an exact repeat is the thing that makes a synthesised knock sound synthetic.
for offset, gain in ((0, 0.88), (int(GAP * RATE), 1.0)):
    for index, value in enumerate(single):
        if offset + index < total:
            samples[offset + index] += value * gain

peak = max(abs(value) for value in samples) or 1.0
frames = b"".join(
    struct.pack("<h", int(max(-1.0, min(1.0, value / peak * 0.86)) * 32767))
    for value in samples
)

with wave.open("Resources/Sounds/knock.wav", "wb") as handle:
    handle.setnchannels(1)
    handle.setsampwidth(2)
    handle.setframerate(RATE)
    handle.writeframes(frames)
print("wrote Resources/Sounds/knock.wav", len(frames), "bytes")
