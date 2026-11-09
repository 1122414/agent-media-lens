# From evidence to a new work

Read the user's words first. Do not infer that the source's format is the user's target.

| Request | Deliver |
|---|---|
| Just a link, “analyze”, or compare works | Analysis only. Do not invent a creative goal. |
| “I want to make something like this”, with no desired type | Analysis plus 2–3 distinct original directions. For each give a concept, the materials it needs and its first shot. Incorporate any constraints the user did give. |
| A free-text target, e.g. “a 60-second narrated screen recording, no camera” | Analysis plus a production plan in the requested format. Make the premise, audience benefit, title, cover, two alternative openings and shot timeline concrete. Each beat needs a visible action, actual spoken line or sound, edit, and on-screen text where useful. Honor duration, available material, crew and no-face/no-sound constraints across all shots. Express assumptions instead of blocking on optional fields. |

## Choosing a comparison

When asked what makes a creator's popular work different, call media_compare_profile. Preserve the user's choice of guest vs local login, sample size, pair count and optional collection. Its result is metadata, not a content analysis. State observed and rankable counts, source (uploads or a named collection/ID), pages, collection restriction, stop reason and uncertainty. Record the actual likes and their timestamps. If no usable pair exists, report the reason and give a single-work reading only if a suitable work is available. Do not substitute another creator or a different collection without saying so. For a single work with no comparison data, never invent an ordinary baseline.

Process both selected URLs of each pair one at a time, since the local worker may allow only one active job. For each call media_resolve and media_analyze; poll to completion before the next. Reuse an identified existing task for the same source and part when available. Read images and available speech from **both**. Label pairs and source IDs. Check topic, age at measurement (especially under 48h), duration, exposure, and comparability after viewing. The helper matches format and dates, not topic or audience. A failed member is not a completed pair. If the only available match is weak, explain what prevents the stronger conclusion.

## Reading the material

Follow the evidence workflow in SKILL.md. Inspect the opening, at least one change, and the payoff or ending. Use detail frames when text or demonstrations matter. For an album cite pages, separate still and live motion, and never treat separate pages as timed cuts.

- **Opening and payoff:** what can someone actually see or learn in the first moments? Who is expected to care? When is the promise fulfilled?
- **Editing, image and sound:** describe observed shot size, framing, ordering, text, pace, transitions, voice or silence when supported. Sampled still frames do not measure an exact cut rate. The transcript is not a recording of the score. No ASR segments does not prove silence. Say what you cannot verify.
- **Content and viewpoint:** identify the argument, demonstration, joke, experience or mood; explain how an example, contrast, omission, visual choice or ending conveys the viewpoint. Separate the maker's explicit claim from your interpretation.
- **Audience:** infer the knowledge assumed and why a viewer might watch, using concrete cues. Do not infer actual demographics, retention, shares or motives from likes. In a comparison, distinguish shared conventions from differences and mention a plausible alternative explanation. Never claim a feature caused high likes.
- Emphasize the dimensions the work actually supports. E.g., check steps and legibility for a tutorial, setup and timing for comedy, sequence and atmosphere for scenic material, the claim and counterexample for opinion. Use this as a lens, not mandatory labels or a list of allowed genres.

## Writing and saving

Give one concrete observation per major claim in the user's language: “A shows … at …; B does … instead; one possible effect is …”. Include counterexamples when both works share a technique. Use a transferable choice such as “reveal the tool's output before its setup”; change subject, materials, words and staging in the original. Do not recycle a creator's footage, slogans or script. Name ideas that depend on privileged access, location, subjects or budget.

Call media_save_study with the completed task IDs in source order and your written analysis. Cite each source inline, for example `[S1:f000]`, `[S2:t1]` (first ASR segment), alongside human-readable times or pages when useful. Use language=en for English headings or zh for Chinese. The tool appends verified references and returns new report paths. Omit creative for analysis only. Without a target use `creative.directions`; with a target use `creative.target`, `title`, `cover`, two `openings`, and `shots` with `when`, `visual`, `audio`, `edit` and optional `caption`. Pass user constraints through. Deliver the actual documents, not a promise to write them. A production plan is not a rendered video.
