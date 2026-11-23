# Tasks + Work + read-only self knowledge

Existing Kotlin/Chaquopy Android app and plain JS UI are preserved; no managed-site migration or new backend service.

- [x] Separate drawer sections Tasks, Work directly below Tasks, Reminders, Alarms (including timers), Notes. A timed task creates a task record AND schedules a notification. Existing local records migrate without deletion. Voice and typed commands use the same lists. Manual add/edit/completion available.
- [x] Work is for explicitly created large projects: title, category, goal, date, minutes, progress, result and notes/activity entries. Completing a small task never creates Work. Add/edit/log/read from Standard commands.
- [x] Settings controls for local assistant reads/edits, relevant personal context shared with online models and a separate old-chats toggle. Opt-in online sharing; whitelist/minimise payloads; keys, PIN and connection credentials excluded. Local actions never need model access.
- [x] AI add/edit/read/completion through allowlisted operations; delete/clear, security/PIN and sensitive settings denied even if confirmed. Existing manual controls are separate. Architecture reference read-only, current actual modules/model chains/voice/action flow; no source writes, self deploy or arbitrary path/file access.
- [x] Chat and voice retain the selected mode throughout a request, never silently promote Standard based on task classification. Non-Standard task commands explain Standard is required without switching/executing. Source selection is preserved. Existing role chains, reasoning and voice fallback remain.

Validation: 251 Python tests and 25 UI integration tests pass, along with classic-script syntax and UI bundle build checks. Independent read-only review findings corrected: safe-setting normalization, old-chat local-turn exclusion, one-shot voice paste cleanup and per-message retry source. The tests exercise the actual classic-script UI, including forms, routing, privacy, migration and confirmations. Native scheduling is source-contract tested; GitHub Actions performs Android APK compilation for the delivered commit.

Real-phone notification delivery, reboot scheduling, microphone and audio behavior are not verified in this sandbox. APK compilation is separate from those device runtime checks. Android notification/exact-alarm permissions and device battery restrictions still apply.
