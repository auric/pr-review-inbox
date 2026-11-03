# A ticked skill without Always use is read in every run: analysis

Status: analysis of 2026-11-03 against main 6baaf2c, after a user report. The user chose options 1b, 2, and 3 on 2026-11-03. The fix changes the rest branch of `skillLines`, so INDEX.md still starts above 5 skills.

## Facts

- The user ticked a new user skill in a review profile, without Always use. From that run on, runs read its SKILL.md. No run called the CLI Skill tool; "load" is a plain Read of the copied SKILL.md.
- Review runs copy only the ticked skills (`copySkills(profile.skills, …)`, src/server/review/jobs.ts). The CLI does not discover skills by itself.
- With 5 or fewer ticked skills (`SKILL_INDEX_AFTER = 5`, src/server/review/skills.ts), `skillLines` (src/server/review/catalog.ts) writes "The user chose these skills: … Read each SKILL.md first and follow it." So a plain tick works like Always use.
- Always use changes only the wording ("Before you start… follow it for the whole run"), the start error for a missing skill, and the not-read note.
- Task steps (after 64eff3a) copy all user skills and get only an index with "open a SKILL.md only when it applies". They record every copied skill in skills_json with always:false, so the log can look as if all are loaded.
- The Always use box renders only for a ticked skill, and only in the Choose… dialog (src/web/settings/ReviewProfiles.tsx). The profile row shows chips with " · Always". The hint about the index and Always shows only above 5 skills.

## Fix options

1. (a) Keep the meaning and show the hint for any count. (b) A tick means "read when it applies": change the rest branch of `skillLines`, or write INDEX.md for any count above 0. Test: `skillLines(["x"], [])` has no "Read each SKILL.md first"; `skillLines(["x"], ["x"])` keeps "Before you start".
2. In the Choose… dialog, show the Always use box for every row, disabled while the skill is unticked.
3. Optional: mark skills that a task step copies only because it gets all skills, so the log does not read them as loaded.
