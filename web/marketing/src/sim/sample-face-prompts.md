# Sample face prompts

The prompt text for the first six portraits was not retained when they were
created on 2026-10-04. On 2026-10-06, Codex's built-in `image_gen` edited all
twelve people into a broader set of laptop and phone frames. Each edit used
that person's existing image as its identity reference. These notes preserve
the reusable prompt recipe and the scene and pose directions for every frame.
They are Codex `image_gen` prompts; no Claude prompt history was available.

All twelve people are fictional. Keep their identity, age, visible features,
skin tone, hair and clothing consistent with the reference image. Every laptop
portrait looks into the webcam. Every phone portrait looks into the phone
camera. Keep heads level; vary shoulders, posture, hand placement, framing and
camera height. Keep the face clear and centered for a square crop. Vary work,
home, travel and public settings across the pool without assigning a setting
based on a person's name or appearance. Exclude readable text, logos and
watermarks.

## Laptop portrait recipe

Start with this prompt, then use the matching scene and pose direction below:

```text
Edit this fictional sample webcam portrait. Preserve exactly the same person's identity, face, age, and visible appearance and clothing. <scene and pose>. Keep the head level and eyes looking directly into the webcam lens. Horizontal 16:9, chest-up, face centered and clear for a square crop, realistic natural webcam photography. No text, logos, watermark, or extra people.
```

| ID | Scene and pose direction | Output |
|---|---|---|
| `sam` | Bright hotel room during a work trip, window and closed carry-on in the background. Seated at a desk, shoulders turned slightly, leaning toward the laptop. | `sam.webp` |
| `amara` | Quiet glass-sided coworking booth, warm wood and tables beyond the glass. Upright with shoulders angled and a mug held low in frame. | `amara.webp` |
| `priya` | Home dining nook by a window, notebook, pen and mug. Seated with shoulders angled, holding a pen above the notebook. | `priya.webp` |
| `lucas` | Small public library reading room and shared table. Seated upright, shoulders square, hands resting low on the table. | `lucas.webp` |
| `camila` | Shared creative workshop with a worktable, pinboard and tools. Leaning forward with her shoulders turned three-quarters. | `camila.webp` |
| `jonas` | Open coworking loft with long tables and broad windows. Standing or perched at a high table, one forearm resting on it. | `jonas.webp` |
| `leila` | Private work pod in an airport business lounge, terminal windows and carry-on behind her. Seated at a narrow desk, making a small low conversational gesture. | `leila.webp` |
| `mateo` | Simple rented apartment kitchen during a work trip, water glass and laptop at the counter. Leaning back slightly with forearms resting on the counter. | `mateo.webp` |
| `amina` | Modern client meeting room, glass door and blank presentation screen. Seated with shoulders turned slightly and hands low on the table. | `amina.webp` |
| `noah` | University commons study lounge with shared tables and windows. Seated sideways to the table with forearms resting on it. | `noah.webp` |
| `idris` | Hotel lobby lounge used as an informal work area. Seated back in a chair, one forearm on the armrest and one hand making a small open gesture. | `idris.webp` |
| `sofia` | Coworking sunroom with plants and a shared table. Standing beside the table, one hand resting on it and torso angled to the side. | `sofia.webp` |

## Phone portrait recipe

Use the existing phone selfie for identity reference and pair it with the
matching scene and pose direction. Keep the gaze on the front-camera lens.

```text
Edit this fictional person's existing phone selfie. Preserve exactly the same person's identity, face, age, and visible appearance and clothing. <scene and pose>. Vertical 9:16 front-camera selfie, head level, eyes looking directly into the phone lens. Keep the face centered and clear for a square crop; use natural light and realistic skin. No text, logos, or watermark.
```

| ID | Scene and pose direction | Output |
|---|---|---|
| `sam` | Airport lounge beside terminal windows, carry-on and gate seating behind him. Phone held slightly below eye level, shoulders and arm in frame. | `sam-phone.webp` |
| `amara` | Outdoor coworking terrace under a pergola with tables and greenery. Phone held above eye level, extended arm at the edge, shoulders relaxed. | `amara-phone.webp` |
| `priya` | Commuter train platform with a stationary train behind her. Phone at eye level, arm entering from one side and one shoulder closer. | `priya-phone.webp` |
| `lucas` | Waterside public park with river railing and city reflections. Phone held high to include sky, torso turned a quarter away. | `lucas-phone.webp` |
| `camila` | Sidewalk cafe terrace with awning, small tables and plants. Phone at eye level in her right hand, shoulders angled. | `camila-phone.webp` |
| `jonas` | City ferry passenger deck with railing, river and distant shore. Phone slightly below eye level, body turned toward the water. | `jonas-phone.webp` |
| `leila` | Hotel lobby by a window, lounge chairs and a carry-on in soft focus. Phone at chest level looking slightly upward; she leans in. | `leila-phone.webp` |
| `mateo` | Covered neighborhood market walkway with unbranded stalls. Phone above eye level and slightly to one side, forearm at the edge. | `mateo-phone.webp` |
| `amina` | Public office courtyard with benches and a glass building. Seated on a bench with phone at eye level in her left hand; shoulders angled. | `amina-phone.webp` |
| `noah` | Underground metro platform with tiled walls and a train in the distance. Phone slightly above eye level, one shoulder turned toward the platform. | `noah-phone.webp` |
| `idris` | Outdoor museum courtyard with a stone wall, modern sculpture and distant trees. Leaning on a low wall, phone slightly below his face. | `idris-phone.webp` |
| `sofia` | Tram stop with tram and glass shelter, no readable signs. Phone at eye level, arm across one corner of frame, shoulders turned slightly. | `sofia-phone.webp` |

The final WebP frames are resized with Sharp to match the site assets:
800×450 for laptop portraits and 450×800 for phone portraits. The originals
returned by `image_gen` remain in the task's generated-images folder.
