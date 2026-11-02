# Nigerian English transcription evaluation protocol

No live Deepgram model-quality evaluation has been run for MediLogNG. Provider-published model descriptions and language lists are not evidence of accuracy on Nigerian English clinical consultations.

## Evaluation set

- Use synthetic consultations first. Real recordings require documented consent, de-identification, hospital approval and a data-protection review of the selected endpoint.
- Include Nigerian English accents, medication/trade/generic names, doses, routes, frequencies, negatives, dates, measurements, background noise, overlapping speech, and code-switching if in scope.
- Keep each sample's audio, reference transcript, adjudication and clinician sign-off under hospital-controlled access. Do not place patient audio/transcripts in this repository.
- Create references independently, then have two reviewers adjudicate disagreements. Keep spoken numbers, negation, names and units exact.

## Procedure

1. Record provider name, exact model identifier, region endpoint, `language` and request options, client device/browser, sample duration, network, run timestamp and app release.
2. Submit each sample through MediLogNG's authenticated clinical flow. Preserve the raw provider transcript; do not normalize or correct it before scoring.
3. Compare with the adjudicated reference using word error rate (WER), substitutions, deletions and insertions. Report medical-term, medication-name, dose, unit, route, frequency, duration, negation/allergy, number/date/measurement errors separately.
4. Have a clinician rate each error's potential impact. Report confidence intervals and per-accent/per-content breakdowns, not only aggregate WER.
5. Retest on a fresh held-out sample before changing model, language, region, keyterm list or audio settings.

WER is one signal; a low aggregate WER can conceal a dangerous dosage or negation error. No automatic transcript correction, diagnosis generation or medication action is authorized. The clinician must review and edit each transcript before it enters the encounter.

See [`accuracy-results-template.csv`](./accuracy-results-template.csv). Keep clinical evaluation evidence in the hospital's approved validation store, not source control.
