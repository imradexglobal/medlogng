# Whisper medical transcription evaluation protocol

## Status

No Nigerian English or clinical consultation audio with verified reference transcripts is available yet. No medical transcription accuracy result can be reported until suitable, consented samples are supplied and reviewed. The initial model remains the pinned English-only `tiny.en-q5_1` model. Yoruba and English/Yoruba code-switching results must be evaluated and reported separately; the English model must not be described as supporting Yoruba based on these tests.

## Sample handling and reference transcripts

- Use only recordings collected with the required informed consent and de-identified before they enter the evaluation workspace. Replace names, phone numbers, addresses, dates of birth, MRNs and other direct identifiers with neutral placeholders while preserving clinically relevant speech.
- Assign a random sample ID. Keep the ID-to-source mapping outside this repository and restrict it to the authorized evaluation team.
- Use a varied set of speakers who self-describe their preferred language and accent. Do not infer ethnicity or language from names or location. Record audio quality, recording device, conversational overlap and background noise.
- Produce a verbatim reference transcript. Two qualified reviewers should independently transcribe each sample; a clinician adjudicates disagreements, especially on clinical terms, drug names, numbers and units. Keep uncertain audio marked as `[unclear]` with a timestamp rather than guessing.
- Do not edit Whisper output before scoring. Preserve the original output and create a separate normalized copy for word-error-rate calculations.
- Store audio and transcripts in an access-controlled, encrypted location. Delete working copies according to the approved retention schedule. Do not put recordings, transcripts or patient details in Git, CI logs or public issue trackers.

## Evaluation sets

Keep the following groups distinct in the report. Use speaker-disjoint development and evaluation samples so one person's voice does not appear in both sets. Record sample counts, speaker counts and total audio minutes for each group.

1. **General Nigerian English:** routine conversation, questions, negation, names of common local places when de-identified or replaced with test names, and varied Nigerian English pronunciations and speaking rates.
2. **Medical terminology:** symptoms, anatomy, examination language, investigations, diagnoses spoken by the clinician, and common abbreviations. Include clear audio and realistic conversational delivery.
3. **Medication names and instructions:** generic and brand names that the speaker actually says, dose values, strengths, units, route, frequency, duration, and negation or discontinuation. Include similar-sounding names and values only when they occur naturally in the consented test material; never add them to a real clinical record as a test.
4. **Numbers, dates and measurements:** ages, dates, times, decimal values, blood pressure, pulse, temperature, oxygen saturation, height, weight, laboratory values, units and ranges. Score digits/words and units using the documented normalization rules below, and separately inspect value-unit pairings.
5. **Yoruba and English/Yoruba code-switching:** a separate exploratory set labelled by the language actually spoken in each segment. Do not combine its score with English-only results. The pinned English model's output on Yoruba segments is descriptive only; it does not demonstrate Yoruba support. Any multilingual-model comparison requires a separate proposal, approval and model/resource evaluation before changing the deployment.

## Transcription procedure

1. Record or select the consented sample and freeze its audio file before running inference. Record its random ID, SHA-256, duration, sample rate, channel count and audio-quality notes.
2. Run the packaged worker with the pinned model and production settings. Do not supply prompts or manually correct the transcript. Record worker/model manifest hashes and processing time.
3. Save the raw worker output exactly as returned. A reviewer then compares it with the adjudicated reference and fills out the results template.
4. Independently double-check every apparent drug, dosage, route, frequency, negation, number, date, measurement and unit mismatch against the audio. Mark unresolvable audio as uncertain rather than treating either transcript as correct.
5. Calculate aggregate and per-category metrics only after adjudication. Keep failed, empty and timed-out jobs in operational reliability reporting; do not silently exclude their audio from the evaluated sample count.

## Word Error Rate

For each sample, align the normalized Whisper transcript to the normalized reference using minimum edit distance and count substitutions (`S`), deletions (`D`) and insertions (`I`). Calculate:

`WER = (S + D + I) / N`

where `N` is the number of words in the reference. Report WER as a percentage, along with `S`, `D`, `I` and `N`. Report micro-averaged WER (sum of edit counts divided by sum of reference words) and the distribution across samples; do not only report an average of per-sample percentages. Also report the percentage of samples with zero clinically significant errors.

Use one documented normalizer for case and punctuation (case-fold text and remove punctuation that does not change meaning). Keep a second clinical-value review that does not collapse differences in drug names, numbers, decimal points, units, dates, routes, frequencies, negation or clinically meaningful abbreviations. Never normalize away those distinctions to improve WER. Report the normalizer version and retain the unnormalized source strings.

## Clinically significant error review

WER is a general text metric and is not a clinical safety score. For every sample, classify each clinically meaningful discrepancy and compare both transcripts with the audio. Use these categories:

- medication/generic or brand name
- strength or dose amount, decimal, unit or package quantity
- route
- frequency or timing
- duration
- start, stop, continue or other medication action
- negation or allergy
- symptom, laterality, severity or duration
- diagnosis or examination statement
- date, age or other number
- vital sign, laboratory value, unit or reference range
- referral, procedure or follow-up action
- other / uncertain

For each discrepancy, record the reference phrase, the Whisper phrase, the verified audio interpretation, the likely clinical consequence, and whether it could change a treatment or follow-up decision. Rate severity using this scale:

- **0 — no clinical impact:** style, punctuation or harmless wording difference.
- **1 — minor:** meaning remains clear and no care decision is affected.
- **2 — moderate:** clinician clarification is needed before documentation or an order is entered.
- **3 — major:** plausible risk of wrong medication, dose, route, frequency, diagnosis, measurement or follow-up if accepted without correction.
- **4 — critical:** likely serious harm if accepted without correction.

Count and report every level 2–4 error separately from WER. Any level 3 or 4 error in medication name, dose, route, frequency, negation or allergy is a release-blocking finding for the affected workflow until a clinical safety review accepts a documented mitigation. Do not silently correct the model or use the clinician review requirement as evidence that an unsafe model output is acceptable.

## Reporting and decision rules

Report results separately for every evaluation group, including sample and speaker counts, audio minutes, WER and edit counts, zero-clinically-significant error rate, severity 2–4 error counts by category, processing time, failures, and confidence intervals where the sample size supports them. Include the manifest hashes, worker settings and all adjudicated examples of clinically significant errors in the restricted evaluation record.

Do not claim that Tiny is accurate enough for medical documentation from startup, a general-audio smoke test or aggregate WER alone. A clinician must review the results and approve the documented use and mitigations. Keep Yoruba/code-switching conclusions separate and unresolved until a suitable reference corpus is tested. Do not change the model or resource settings without presenting measured quality, language, memory and CPU trade-offs for approval.

## Results template

Use [`accuracy-results-template.csv`](./accuracy-results-template.csv), one row per sample. Store completed copies only in the approved restricted evaluation location, not in this repository.
