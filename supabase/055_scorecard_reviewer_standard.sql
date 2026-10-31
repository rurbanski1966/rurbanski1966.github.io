-- ============================================================================
-- Lana — migration 055: CAMP scorecard graded to the reviewer's standard
--
-- Additive. Run after 054. Safe to re-run.
--
-- Per Ryan 2026-10-31: train the CAMP grader on his manual regrades of the
-- 8 most recent EWSS calls (10/30). Across those he changed 52 item verdicts,
-- almost all fail -> pass, for one consistent reason: the grader treated
-- every checkpoint as all-or-nothing and demanded exact script wording,
-- where he passes an item the agent substantially covered ("3 out 4 covered,
-- pass it", "4 out 5 covered pass it"). Each item below gets its context
-- rewritten to the standard he actually applies, so the grader reaches his
-- verdicts on its own. Applies to every agency (Ryan: one standard for all).
--
-- Also folds in 041 (13.1 full name anywhere) and 044 (14.1 TPMO, no time
-- limit): the active version was still 2026-10-15.1, so neither had taken
-- effect.
--
-- Built from whichever version is active (not a named one), and the active
-- flag handed over. Calls already graded keep their grade; regrade one to
-- apply the new standard to it. score-scorecard's instructions change in the
-- same commit (substantial-compliance rule, risky moments still alerted).
-- ============================================================================

insert into public.scorecards (name, version, is_active, definition)
select
  s.name,
  '2026-10-31.1',
  false,
  jsonb_set(s.definition, '{sections}', (
    select jsonb_agg(
      jsonb_set(sec, '{items}', (
        select jsonb_agg(
          case when m.patch ? (item->>'id') then item || (m.patch -> (item->>'id')) else item end
          order by item_ord)
        from jsonb_array_elements(sec->'items') with ordinality as i(item, item_ord)
      ))
      order by sec_ord)
    from jsonb_array_elements(s.definition->'sections') with ordinality as x(sec, sec_ord)
  ))
from public.scorecards s
cross join (select $patch$
{
  "2.2": {
    "context": "Did the agent verify the beneficiary's current health coverage? PASS when the agent identifies or confirms the beneficiary's current Medicare coverage (plan or carrier), whether by asking or by reciting it from a lookup and having the beneficiary confirm. Asking about employer/union coverage and VA/Tricare is good practice and should be reported in the checkpoints, but leaving one or both out does not fail this item. FAIL only if current coverage was never identified or confirmed at all. If the beneficiary says they have Tricare, Tricare for Life or ChampVA and the agent still pitches a Medicare Advantage plan without explaining that it is not recommended, raise an alert (we do not sell to anyone with Tricare)."
  },
  "3.2": {
    "context": "The agent should keep the appointment to the plan types read in the SOA (Scope of Appointment) disclaimer. Offering a transfer or referral to a separate service or partner (for example a medical alert service such as LifeShield) is not a failure. FAIL only if the agent actually presents, quotes or sells a product outside the plan types read in the SOA during this call."
  },
  "3.3": {
    "context": "PASS when the agent read the SOA and the beneficiary agreed or did not object to discussing the plans (a 'yes', 'sure', 'okay', 'go ahead', or answering 'no' to 'do you have any questions on that?' all count). Stating the appointment date or the word 'today' is not required. FAIL only if the beneficiary declined, or the SOA was never read."
  },
  "3.4": {
    "context": "PASS when the agent gives, or refers the beneficiary to, a way to reach them or the agency again: a callback number, the agency number, a number given earlier in the call, or an offer to write down their name and number. FAIL only if no way to reach the agent or agency was offered or referred to at any point."
  },
  "4.1": {
    "context": "The Sunfire other-coverage questions: Other Rx coverage, Long term care/nursing home, Other health coverage, Applicant/spouse work status, Medicare Supplement understanding, plus any disclaimer the answers call for. PASS when the agent asked most of these (for example nursing home status plus the Medicare Advantage is-not-a-Supplement statement, or nursing home plus work status). Report each one in the checkpoints. FAIL only if the agent skipped this section entirely or asked just one of them."
  },
  "5.1": {
    "context": "PASS when the agent identified, confirmed or selected the beneficiary's PCP (by name) for the application, and either said the doctor is in network or confirmed the doctors are in network with the carrier generally. A PCP chosen on the application with the agent counts. FAIL only if the PCP was never discussed or captured."
  },
  "5.2": {
    "context": "The agent must ask whether the beneficiary sees any other doctors or specialists they want looked up (for example 'Do you see any other doctors, or have any other doctors you want me to check?'). PASS when the agent asked and either looked them up or the beneficiary said there were none. Referral requirements only need mentioning if the plan requires them and the beneficiary has a specialist. FAIL if the agent never asked about other doctors or specialists."
  },
  "7.1": {
    "context": "PASS when the agent states the inpatient hospital cost for the plan with its basic structure: the amount and the days it applies to (for example '$175 for the first five days, then 0 after that'), or a per-stay amount. The words 'dollars', 'per day' or 'per stay' do not have to be said, a '$0' or '0' for later days counts, and these are machine transcripts, so '$3.75' or '3.75' is a mis-heard '$375'. FAIL only if the agent never gave an inpatient hospital cost."
  },
  "7.2": {
    "context": "PASS when the agent states the plan's medical deductible in any clear way: '$0', 'zero', 'no medical deductible', or the amount ('990', '$990'). The exact phrase 'This plan does not have a medical deductible' and the word 'dollars' are not required. FAIL only if the agent never mentioned the medical deductible."
  },
  "8.2": {
    "context": "PASS when the agent gives the Emergency Room copay. Adding the waiver (ER copay waived if admitted within 24 hours) and the urgent care copay is better and should be reported in the checkpoints, but leaving out urgent care does not fail this item. FAIL only if no emergency room cost was given."
  },
  "8.3": {
    "context": "Four parts: Maximum Out-of-Pocket (MOOP), preventive services at $0, mental health cost, and other benefits the beneficiary asked about (fitness, OTC, food card, transportation, etc.). PASS when at least 3 of the 4 were presented. Inpatient mental health alone counts for mental health; outpatient is not separately required. Report each part in the checkpoints. FAIL only if 2 or fewer were presented."
  },
  "9.3": {
    "context": "The Late Enrollment Penalty (LEP), Extra Help and IRMAA disclosures. PASS when the agent read at least the Late Enrollment Penalty disclosure, including when it is read as part of the enrollment application. Report Extra Help and IRMAA in the checkpoints. FAIL only if none of the three was read."
  },
  "9.4": {
    "context": "If the plan the beneficiary enrolls in includes a Part B premium reduction (Part B Giveback), the agent should state the giveback amount and explain it. PASS when the agent stated the giveback amount for that plan. PASS as well when the plan has no Part B giveback: grade it 'pass', never 'na'. Use 'na' only if no plan was chosen on the call. FAIL only if the chosen plan has a giveback and the agent never stated its amount."
  },
  "11.1": {
    "context": "PASS when the agent confirms the plan the beneficiary is enrolling in by name AND conveys the proposed effective date. The plan/PBP contract number is not required, and the date may be given as month and year or as 'January, because this is the 2027 plan' as well as '01/01/2027'. FAIL only if the plan was never named or no effective date was given at all."
  },
  "13.1": {
    "context": "Five demographics: Full name, Date of birth, Physical address, Mailing address, County. The agent may ask for them, or recite them (after HIPAA verification) and have the beneficiary confirm. PASS when at least 4 of the 5 were collected or confirmed; a missing county alone, or a partly mis-transcribed date of birth, does not fail it. The Full Name checkpoint is met if the beneficiary's full (first and last) name was verified at ANY point in the call: the opening, HIPAA verification, the application, or anywhere else. Never mark Full Name missed because of where in the call it happened. FAIL only if 2 or more of the 5 were never collected or confirmed."
  },
  "14.1": {
    "context": "The TPMO disclaimer must be said during the call. There is no time limit: it does NOT have to be said in the first minute, and saying it at any point in the call meets this item. Never mark it non-compliant, or flag it for review, because of when in the call it was said. PASS when the agent said they do not offer every plan available in the area, with the number of organizations and/or products they represent. Mentioning Summary of Benefits and star rating availability, Medicare.gov and 1-800-MEDICARE is better and should be noted, but leaving them out does not fail this item. If the beneficiary chooses the text signature for enrollment, this disclosure can be omitted. FAIL only if the 'we do not offer every plan' disclaimer was never said.",
    "checkpoints": ["TPMO disclaimer"]
  },
  "14.6": {
    "context": "Four enrollment disclosures: Release of Information (the plan will share information with Medicare and other plans as necessary), Agent Commission (a sales agent or broker may be paid based on your enrollment), Accurate Information/Disenrollment (information must be correct; you may be disenrolled for false information), and Medicare A and/or B (you must keep both Part A and Part B to stay in the plan). PASS when at least 3 of the 4 were read. Report each in the checkpoints. FAIL only if 2 or more were never read."
  },
  "15.1": {
    "context": "PASS when the agent answered the questions the beneficiary actually asked and the call went forward without the agent ignoring or brushing off a direct question. Imperfect cost math, a fast pace, some dead air, jargon, casual reassurance, or a beneficiary who sounds hesitant do NOT fail this item on their own. FAIL only if the agent ignored or refused a direct question, gave plainly false information in answer to a question, or kept the beneficiary on long unexplained holds. Separately: if the beneficiary shows signs of confusion about what they are agreeing to, possible cognitive impairment, or hesitancy that the agent pushed past to get a signature, PASS the item as above but add an alert describing it so a compliance lead sees it."
  },
  "15.2": {
    "context": "PASS when, before the call ended, the agent gave the enrollment confirmation/application number and a contact number (the plan's customer service number or the agent/agency number). The cancellation notice (the current carrier may call to confirm the change) is good practice and should be reported in the checkpoints, but leaving it out does not fail this item. FAIL only if no confirmation number and no contact number were given."
  },
  "16.2": {
    "context": "The agent asks the beneficiary to agree to complete the enrollment (scripted: 'If you agree to complete your enrollment now, please state your name, your date of birth, and that you agree.'). PASS when the agent asked for the beneficiary's agreement or acknowledgment and the beneficiary responded by stating their name and date of birth or saying yes. The exact script wording and the words 'I agree' are not required. If the beneficiary chooses the text signature for enrollment, this can be omitted. FAIL only if the agent never asked for agreement or acknowledgment, or the beneficiary declined."
  },
  "16.3": {
    "context": "Before reading the enrollment application, the agent should check that the beneficiary wants to move forward. PASS when the agent asked anything that confirms the beneficiary wants to go ahead with the plan, for example 'Would you like to go ahead and enroll?', 'Is that something you'd be open to?', or 'Do you want to move forward with this plan?', and the beneficiary agreed. For AmeriHealth plans, the agent needs to tell the beneficiary to call them back to enroll. FAIL only if the agent started the application without any check that the beneficiary wanted to proceed."
  },
  "17.1": {
    "context": "PASS when the agent asked about the beneficiary's needs at any point in the call: their doctors, their medications, and/or the benefits that matter to them (dental, vision, hearing, transportation, etc.). Asking specifically about durable medical equipment (DME) and physical therapy (PT) is good practice and should be noted in the reason, but it is not required, and neither is completing the assessment before the plan recommendation. FAIL only if the agent never asked about the beneficiary's needs at all."
  },
  "17.2": {
    "context": "Avoid superlatives about plans, networks and formularies that state an absolute or unverifiable claim, such as 'the best plan available', 'the biggest network', 'the number one plan in your area', or a guarantee. The agent giving a personal opinion of a carrier ('Aetna's a great company, I like them'), or comparing the plan to the beneficiary's current plan or to the carrier's other plans ('this one's copays are much lower than the other ones'), is permitted. FAIL only for an absolute superlative or guarantee."
  },
  "17.3": {
    "context": "The agent should not present only favorable or leading information to steer the beneficiary. Casual remarks about Medicare costs (for example calling the Part B premium a bad deal), agreeing with a beneficiary's frustration, or advising the beneficiary about unsolicited callers do not fail this item on their own. FAIL only if the agent misrepresents or hides a material plan cost or limitation to push the sale, or makes a specific false claim about a competing carrier or plan. Separately: if the agent tells the beneficiary to hang up on, ignore, or not listen to other agents or plans, PASS the item as above but add an alert describing it so a compliance lead sees it."
  },
  "17.5": {
    "context": "The agent should stay professional. Informal humor, casual language and light remarks about Medicare or other carriers do not fail this item. FAIL only for profanity, insults or slurs directed at the beneficiary or anyone else, or an explicit attack on a named carrier or agency (for example 'that carrier is terrible', 'your current plan is ripping you off'). If the agent makes a remark that could offend a beneficiary (for example about mental health), PASS the item but add an alert describing it."
  }
}
$patch$::jsonb as patch) m
where s.is_active
  and s.version <> '2026-10-31.1'
  and not exists (select 1 from public.scorecards where version = '2026-10-31.1');

-- Hand the active flag over to the new version, once it exists.
do $$
begin
  if exists (select 1 from public.scorecards where version = '2026-10-31.1' and not is_active) then
    update public.scorecards set is_active = false where is_active;
    update public.scorecards set is_active = true  where version = '2026-10-31.1';
  end if;
end $$;
