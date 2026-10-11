-- ============================================================================
-- Lana — migration 035: pass/fail scorecards
--
-- Additive. Run after 034. Safe to re-run.
--
-- A scorecard is a checklist: a fixed list of yes/no items, each worth a set
-- number of points. It is a different instrument from the rubric (migration
-- 004), which scores a call 0-100 across a handful of dimensions for coaching.
-- A scorecard answers "did the agent do each required thing", item by item,
-- which is what a compliance audit asks.
--
-- Nothing here touches call_scores. A call keeps its rubric score, and may
-- also carry a scorecard grade in call_scorecards. Leaderboards and reports
-- keep reading the rubric score until someone decides otherwise.
--
-- Same split as migration 007: the model's grade (items, earned, possible,
-- percent) is written once by the score-scorecard Edge Function and never
-- edited. A reviewer's regrade lands in the manual_* columns beside it, so
-- what the model said stays visible next to what a person decided.
-- ============================================================================

create table if not exists public.scorecards (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  version     text not null unique,
  is_active   boolean not null default false,
  -- { total_points, applies_to_scripts: [script name],
  --   sections: [{ section_number, section_name, max_points,
  --                items: [{ id, question, context, example, weight, points, checkpoints }] }] }
  definition  jsonb not null,
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles (id) on delete set null
);

-- One active scorecard, enforced the same way as scoring_rubrics.
create unique index if not exists scorecards_one_active
  on public.scorecards (is_active) where is_active;

create table if not exists public.call_scorecards (
  id                 uuid primary key default gen_random_uuid(),
  recording_id       uuid not null references public.call_recordings (id) on delete cascade,
  agent_id           uuid references public.profiles (id) on delete set null,
  scorecard_id       uuid references public.scorecards (id) on delete set null,
  scorecard_version  text not null,

  -- The model's grade. One entry per scorecard item, in scorecard order:
  -- [{ id, verdict: pass|fail|na, confidence, reason, evidence: [quote],
  --    checkpoints: [{ name, status }], needs_review, review_reason }]
  items              jsonb not null,
  alerts             jsonb not null default '[]'::jsonb,
  -- N/A items are left out of both numbers.
  earned             integer not null,
  possible           integer not null,
  percent            numeric(5,1),

  -- A reviewer's regrade: { item id: { verdict, note, checked } }. Null until
  -- someone changes or confirms something.
  manual_items       jsonb,
  manual_earned      integer,
  manual_possible    integer,
  manual_percent     numeric(5,1),
  reviewed_by        uuid references public.profiles (id) on delete set null,
  reviewed_at        timestamptz,

  model              text,
  input_tokens       integer,
  output_tokens      integer,
  cache_read_tokens  integer,
  cost_usd           numeric(10,5),
  created_at         timestamptz not null default now()
);

create index if not exists call_scorecards_recording_idx
  on public.call_scorecards (recording_id, created_at desc);


-- ---------------------------------------------------------------------------
-- RLS. Scorecards: everyone reads, admins write — people graded by a standard
-- can see the standard. Grades: same rules as call_scores, and for the same
-- reason there is no insert policy: only the Edge Function creates a grade.
-- ---------------------------------------------------------------------------
alter table public.scorecards      enable row level security;
alter table public.call_scorecards enable row level security;

drop policy if exists scorecards_read  on public.scorecards;
drop policy if exists scorecards_admin on public.scorecards;

create policy scorecards_read on public.scorecards
  for select to authenticated using (true);

create policy scorecards_admin on public.scorecards
  for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists call_scorecards_select_own on public.call_scorecards;
drop policy if exists call_scorecards_admin      on public.call_scorecards;

create policy call_scorecards_select_own on public.call_scorecards
  for select using (
    agent_id = auth.uid()
    or exists (
      select 1 from public.call_recordings r
      where r.id = recording_id and r.uploaded_by = auth.uid()
    )
  );

create policy call_scorecards_admin on public.call_scorecards
  for all using (public.is_admin()) with check (public.is_admin());


-- ---------------------------------------------------------------------------
-- Seed: the CAMP Medicare Call Scorecard (Spark_Score_Card_1.xlsx),
-- 56 items, 159 points.
-- ---------------------------------------------------------------------------
insert into public.scorecards (name, version, is_active, definition)
select
  'CAMP Medicare Call Scorecard',
  '2026-10-08.1',
  not exists (select 1 from public.scorecards where is_active),
  $scorecard$
{
  "rubric_name": "CAMP Medicare Call Scorecard",
  "source_file": "Spark_Score_Card_1.xlsx",
  "applies_to_scripts": [
    "Medicare Script EWSS",
    "Medicare Script SMC"
  ],
  "total_points": 159,
  "item_count": 56,
  "weight_points": {
    "HIGH": 3,
    "MEDIUM": 2,
    "LOW": 1
  },
  "sections": [
    {
      "section_number": 1,
      "section_name": "Introduction",
      "max_points": 9,
      "items": [
        {
          "id": "1.1",
          "question": "Did the agent provide their first and last name?",
          "context": "The agent must provide their first and last name as part of the introduction during each call.",
          "example": "Hello, my name is John Smith, and I'm a licensed sales agent with [Company Name].",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "First name",
            "Last name"
          ]
        },
        {
          "id": "1.2",
          "question": "Did the Agent indicate that they are a licensed sales agent and that the call is being recorded?",
          "context": "Agent needs to state they are a Licensed Sales Agent. Did the agent state that this call is monitored and/or recorded? Agents can also state that they are a Licensed Agent or a Licensed Insurance Agent.",
          "example": "I'm a licensed sales agent, and this call is being monitored or recorded. We do not offer every plan available in your area. Any information we provide is limited to those plans we do offer in your area. Please contact Medicare.gov or 1-800-MEDICARE to get information on all of your options.",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "Licensed Sales Agent",
            "Recorded line"
          ]
        },
        {
          "id": "1.3",
          "question": "Did the agent refrain from implying affiliation with Medicare?",
          "context": "The agent should avoid implying employment with, endorsements from or direct affiliation with Medicare. Avoid statements like \"I am a Medicare Advisor\", \"I am with Medicare\", \"I work for or I am with Humana, Aetna, WellCare, United Healthcare, UPMC, AmeriHealth\"",
          "example": "I'm a licensed insurance agent specializing in Medicare plans, but I'm not employed by or affiliated with Medicare itself.",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": []
        }
      ]
    },
    {
      "section_number": 2,
      "section_name": "Qualification",
      "max_points": 9,
      "items": [
        {
          "id": "2.1",
          "question": "Did the agent ask the beneficiary to provide their First and Last name and ask the decision maker question?",
          "context": "The agent should request the beneficiary to provide their first and last name. The agent should also ask the decision maker question: 'Do you make your own healthcare decisions?' or 'Do you usually have help making your healthcare decisions?' or 'Are you interested in discussing Medicare plan options for yourself or for someone else?' Agents must ask and document POA (Power of Attorney) status if they are not speaking directly to the beneficiary. If the POA is needed, they must be present on the call.",
          "example": "Do you you do you make your own healthcare decisions, or does someone else make it for you?. Do you currently have someone that signs all your legal documents for you as your power of attorney, or do you make your own legal decisions?",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "Beneficiary - First and Last name",
            "Decision Maker"
          ]
        },
        {
          "id": "2.2",
          "question": "Did the Agent inquire about existing coverage?",
          "context": "Did the agent verify the client's current health coverage? Did the agent ask about other health coverage like Employer or Union Coverage? Did the agent ask about VA and/or Tricare? Flag call if the client states yes for Tricare. We do not sell to anyone with Tricare. if the beneficiary has Tricare for Life or ChampVA, did the agent explain that enrolling in a Medicare Advantage plan is not recommended and explain the coverage implications?",
          "example": "Can you tell me about your current health coverage? Do you have any coverage through an employer or union? Are you covered by VA or Tricare?",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "Current Health Plan",
            "Employer/Union Coverage",
            "VA/Tricare"
          ]
        },
        {
          "id": "2.3",
          "question": "Did the agent collect sufficient evidence the beneficiary will be eligible for plan and election period?",
          "context": "Agent should verify if the beneficiary has Medicare parts A & B. Did the agent state the client's LIS level and/or Medicaid status? For CSNP only: Did the agent verify the client has a qualifying chronic condition. Did the agent ask for the zipcode in order to search for plan service area?",
          "example": "Can you confirm you have both Medicare Part A and Part B? Are you receiving any Extra Help or Medicaid benefits? What's your zip code so I can check which plans are available in your area?",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "Medicare A & B",
            "LIS/Extra Help, Medicaid status",
            "CSNP-if applicable",
            "Zipcode"
          ]
        }
      ]
    },
    {
      "section_number": 3,
      "section_name": "Scope of Appointment",
      "max_points": 10,
      "items": [
        {
          "id": "3.1",
          "question": "Did the agent include all required elements of SOA on recording.",
          "context": "The agent must state 'This conversation has no effect on your current or future health coverage unless you enroll in a plan today. The agent must state: 'talking to me does not obligate you to enroll or automatically enroll you in a plan.' (additionally acceptable phrasing 'there will be no effect on current coverage') The agent must state '[agency] offers [any of the following] - Medicare Advantage plans, Stand-Alone Prescription Drug plans, Medicare Supplements Insurance Plans, Stand-Alone Dental, Vision, and Hearing, and Hospital Indemnity options.'",
          "example": "Today, I'll be discussing Medicare Advantage plans with you. This conversation won't affect your current coverage, and you won't be automatically enrolled in any plan we discuss. Do I have your permission to discuss all plan types that we offer?",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "No impact to current coverage",
            "Won't be automatically enrolled into a plan",
            "Plan types to be reviewed during appointment"
          ]
        },
        {
          "id": "3.2",
          "question": "Did the agent refrain from cross selling by excluding non health related products from the marketing appointment?",
          "context": "The agent cannot offer or make any references outside of a Medicare Advantage plan or plan discussed as part of the SOA (Scope of Appointment) disclaimer. SOA example: '[agency] offers [any of the following] - Medicare Advantage plans, Stand-Alone Prescription Drug plans, Medicare Supplements Insurance Plans, Stand-Alone Dental, Vision, and Hearing, and Hospital Indemnity options.' Only the plans read as part of this disclaimer by the agent may be discussed. If any other plans are discussed, fail this question.",
          "example": null,
          "weight": "HIGH",
          "points": 3,
          "checkpoints": []
        },
        {
          "id": "3.3",
          "question": "Did the agent set an appointment date by either stating the date of appointment(in the future) or mention the appointment will take place 'today' and confirm the beneficiary's agreement.",
          "context": "The agent must get a clear 'Yes' for the SOA agreement. The agent must state the date of the appointment (future date or 'today'). Did the agent state the date of the appointment?",
          "example": "I'd like to discuss Medicare Advantage plans with you today, August 20, 2024. Do I have your permission to proceed with this appointment? Please answer with a clear 'Yes' if you agree.",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "Setting the appointment",
            "Beneficiary agreement"
          ]
        },
        {
          "id": "3.4",
          "question": "Did the agent provide a way for the beneficiary to contact them again if they have questions or if their needs change?",
          "context": "The agent must provide the beneficiary with a method to reach them again after the call. This could be a direct callback number, agency phone number, or other contact method. This ensures the beneficiary has ongoing support and can reach out if they have questions about their plan or if their needs change and they want to look at other plan options.",
          "example": "If you have any questions about your plan or if your needs change and you want to look at other plan options, please give me a call at [Phone Number].",
          "weight": "LOW",
          "points": 1,
          "checkpoints": [
            "Agent/agency contact number provided"
          ]
        }
      ]
    },
    {
      "section_number": 4,
      "section_name": "Other Coverages",
      "max_points": 3,
      "items": [
        {
          "id": "4.1",
          "question": "Did the agent confirm the beneficiary other health coverage, other prescription coverage, and read applicable disclaimers based on beneficiary responses? As part of Sunfire scripting these questions should be asked in regards to coverages once plan becomes active.",
          "context": "Agent should ask about Other Rx Coverage, Long Term Care/Nursing Home, Other Health Coverage, Applicant/Spouse employment Status, and Medicare Supplement Coverage. Read any scripted disclaimer(s) applicable to other coverage provided, if applicable. Other Rx Coverage: Will you have any other prescription drug coverage when this plan becomes effective?* Yes or No, Long Term Care/Nursing Home: Are you currently a resident in a nursing home or long-term care facility? Yes or No, Other Health Coverage: Will you have any medical insurance other than Medicare or Medicaid when this plan becomes effective?* Yes or No, Applicant/Spouse work status: Once enrolled, will you or your spouse work? Yes or No, Applicable Disclaimers: Read any scripted disclaimer(s) applicable to other coverage provided, if applicable. Medicare Supplement Coverage: Do you understand that this is a Medicare Advantage plan that has a contract with the Federal Government and IS NOT a Medicare Supplement plan?* Yes or No",
          "example": "Once this plan becomes effective, will you have any other prescription drug coverage? Are you currently in a nursing home or long-term care facility? Will you have any medical insurance other than Medicare when this plan becomes effective? Will you or your spouse be working once enrolled? Do you understand that this is a Medicare Advantage plan and not a Medicare Supplement plan?",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "Other Rx Coverage",
            "Long Term Care/Nursing Home",
            "Other Health Coverage",
            "Applicant/Spouse employment Status",
            "Applicable Disclaimers",
            "Medicare Supplement Coverage"
          ]
        }
      ]
    },
    {
      "section_number": 5,
      "section_name": "Doctors",
      "max_points": 9,
      "items": [
        {
          "id": "5.1",
          "question": "Did the agent obtain/verify consumers choice of PCP and provided network status?",
          "context": "Did the agent ask if there is a PCP(primary care physician) you see? Did the agent ask to look them up? Did the agent capture the complete first and last name of PCP and verify provider's address? Did the agent accurately verify network status?",
          "example": "Is there a primary care physician you currently see? Can you provide their full name and address? Let me check if Dr. Jane Smith at 123 Main St is in-network for this plan. I can confirm that Dr. Smith is in-network for this plan.",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "PCP",
            "Network status"
          ]
        },
        {
          "id": "5.2",
          "question": "Did the agent obtain/confirm the beneficiary's choice of Specialist(s) and provide network status? Did the agent accurately indicate specialist referral requirements if/when required by the plan?",
          "context": "Are there any other doctors you want me to look up to confirm they are in the network with this plan? Agent needs to confirm: Complete first and last name, address should be obtained and confirmed that they are in network. Accurately indicate specialist referral requirements when required by the plan SOB.(If no referral requirement exists for the plan, the agent is not required to mention it unless the client inquires.)",
          "example": "Are there any specialists you'd like me to check for network status? For Dr. John Doe, cardiologist at 456 Elm St, I can confirm he's in-network. This plan requires a referral from your PCP to see specialists.",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "Specialist",
            "Network Status",
            "Referral Requirement (if applicable)"
          ]
        },
        {
          "id": "5.3",
          "question": "Did the agent ask about the beneficiary's preferred hospital and pharmacy, verify network status for both, and confirm network status for any other facilities indicated?",
          "context": "The agent must proactively ask two questions in this section: **Hospital:** The agent must ask if the beneficiary has a preferred hospital or one they have used in the past. The agent must then verify and accurately state whether that hospital is in-network or out-of-network for the plan. **Pharmacy:** The agent must ask: 'Is there a pharmacy you normally use to get your medications, or do you get them via mail order?' The agent must accurately distinguish between preferred network status and standard network status. The agent must not state or imply that a pharmacy is 'preferred' if it is only standard in-network. If the pharmacy is not in the plan's network, the agent must inform the beneficiary that they will likely need to select a new pharmacy for their prescriptions. **Other facilities:** The agent does not need to proactively ask about other facilities such as outpatient surgery centers or dialysis centers. However, if the beneficiary mentions such a facility, the agent must verify its network status. **Exception:** If the beneficiary has VA or tribal benefits, the agent does not need to discuss medications unless the beneficiary mentions obtaining one or more medications from a civilian pharmacy.",
          "example": "Which pharmacy do you typically use for your prescriptions? I see that CVS at 789 Oak St is a preferred pharmacy in this plan's network. Are there any hospitals or other medical facilities you'd like me to check?",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "Hospital",
            "Pharmacy & Network status"
          ]
        }
      ]
    },
    {
      "section_number": 6,
      "section_name": "Prescriptions",
      "max_points": 18,
      "items": [
        {
          "id": "6.1",
          "question": "Did the agent offer Rx lookup without discouraging the beneficiary or mis-characterization of the lookup?",
          "context": "Agents must offer to look up the beneficiary's medication list WITHOUT combining it with another question. If the beneficiary declines lookup, the requirement is met. If the beneficiary has VA coverage, the requirement is met. If the plan is an MA ONLY plan, no prescriptions need to be covered. If the beneficiary initially declines, the agent should remind them (this is encouraged, NOT pressure): 'I suggest if you do have prescriptions, we look them up since it is important to ensure they would be covered on the plan you select, to have an idea of the costs. We can also do this later in the pocess, prior to enrollment, if you prefer.' For PDP-specific: 'I suggest we look them up since it is possible they mary not be covered or require prior authorization and may lead to higher than expected out of pocket costs.' The agent must NOT discourage the lookup or minimize its importance.",
          "example": "Are there any medications you'd like me to look up for you to ensure they're covered by the plan? If you decline, please note that if a prescription is not on the formulary, it will not be paid for by Medicare or the plan without authorization from a doctor.",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "RX look up was offered",
            "RX look up was not discouraged"
          ]
        },
        {
          "id": "6.2",
          "question": "Did the agent provide the prescription deductible?",
          "context": "Agent should provide the beneficiary with the Rx deductible amount if applicable, including which tiers it applies to. If no medications are provided, the entire deductible must be provided. If medications are provided, the deductible should be provided as it applies to their medications. If the beneficiary has VA coverage, the requirement is met. If the plan is an MA ONLY plan, no prescriptions need to be covered.",
          "example": "The prescription drug deductible for this plan is $100. This means you'll pay the full cost of your prescriptions until you've spent $100, after which the plan's copayments or coinsurance will apply.",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": []
        },
        {
          "id": "6.3",
          "question": "Did the agent accurately collect medications and confirm formulary coverage for each medication?",
          "context": "Accurate collection of medications requires Form (tablet, capsule, XL, ER, ODT, SOL, OINT, CRM etc.), Dosage (mg, ml, mcg etc.), Package size (if applicable), Quantity (amount used each day) and Frequency (how often do they refill? 30-60-90 days.). The information provided need not be explicitly mentioned. The requirement is met if the beneficiary declines the medication lookup. If the beneficiary has VA coverage, the requirement is met. If the plan is an MA ONLY plan, no prescriptions need to be covered.",
          "example": "You mentioned taking lisinopril. Can you tell me the form - is it a tablet or capsule? What's the dosage in mg? How many do you take per day, and do you usually get a 30-day or 90-day supply? Based on this information, I can confirm that lisinopril 10mg tablets are covered by this plan's formulary.",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "Accurate Medications",
            "Formulary coverage (covered or not covered)"
          ]
        },
        {
          "id": "6.4",
          "question": "Did the agent accurately provide dispensing or utilization restrictions (Quantity Limits, Step Therapy, Prior Authorization) if applicable.",
          "context": "The agent must provide any applicable utilization management/dispensing restrictions (quantity limits, prior authorization, and step therapy) for each medication. If the agent, says \"I understand, we do not need to look up your medications. Just be aware that if a medication is not on the formulary, it will not be paid for by Medicare or the plan without authorization from a doctor.\" Then you can mark everything compliant. If the beneficiary has VA coverage, the requirement is met. If the plan is an MA ONLY plan, no prescriptions need to be covered.",
          "example": "For the lisinopril, there's a quantity limit of 30 tablets per 30 days. There's no step therapy or prior authorization required for this medication.",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "Quantity Limit",
            "Step Therapy",
            "Prior Authorization"
          ]
        },
        {
          "id": "6.5",
          "question": "Did the Agent accurately provide prescription costs? Did the agent accurately provide Initial Coverage copay/coinsurance for each medication (based on beneficiary's pharmacy choice and/or frequency choice [30/90/100 day supply])",
          "context": "The agent must provide the Initial Coverage copay/coinsurance for each medication. If $0 = the copay/coinsurance for these medications, the agent must still state it as $0 copay. If the beneficiary has VA coverage, the requirement is met. If the plan is an MA ONLY plan, no prescriptions need to be covered.",
          "example": "For lisinopril, your copay will be $5 for a 30-day supply at a preferred pharmacy. If you choose a 90-day supply, the copay would be $15.",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": []
        },
        {
          "id": "6.6",
          "question": "Catastrophic coverage. The Agent must provide an accurate and complete description of Catastrophic coverage.",
          "context": "✓ PASS if agent provides: General description of catastrophic stage as it pertains to the plan Required details if consumer requests: Threshold amounts for reaching catastrophic Calculation methodology for reaching catastrophic Must be provided accurately ✓ PASS (EXEMPT from disclosure) if ANY: • Extra Help/LIS LEVEL verified (e.g., 'LIS Level 1') • DSNP plan AND Medicaid status confirmed • Consumer's LIS level mentioned at any point CRITICAL DISTINCTION: • 'You have Extra Help' WITHOUT level = NOT verified • 'You have LIS Level 1' = VERIFIED (can omit) • Medicaid level confirmed (QMB, SLMB) = VERIFIED FAIL if: DSNP without catastrophic stage listed → Disclosure IS required (agent must still provide it) Agent provides inaccurate threshold or calculation methodology Agent fails to provide description when required (no Extra Help/LIS verified) DO NOT FAIL if: • DSNP where Medicaid/LIS level was confirmed • Any plan where LIS level (1,2,3,4) was stated",
          "example": "* COMPLIANT (NO CATASTROPHIC NEEDED) - 'I see you have LIS Level 1, so catastrophic doesn't apply' - 'Since you're on Medicaid with QMB, you're exempt' - 'Your Extra Help Level 2 means you're covered' * NON-COMPLIANT (CATASTROPHIC REQUIRED): - Agent mentions Extra Help but never states the level - MAPD plan with no LIS discussion",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "Catastrophic coverage"
          ]
        }
      ]
    },
    {
      "section_number": 7,
      "section_name": "Benefit Review: Baseline Benefits",
      "max_points": 13,
      "items": [
        {
          "id": "7.1",
          "question": "Did the agent accurately provide complete inpatient hospital coverage and cost?",
          "context": "The agent must indicate coverage amount. If the copay/coinsurance is $0, the agent must still state as $0 copay/cost. If the cost is listed as a range, the agent must provide the complete range. Agent must include 'per day' or 'per stay' as applicable. ALL monetary amounts MUST include 'dollars' (e.g., '$315 dollars'). Time qualifiers 'per day' or 'per stay' must be stated. Complete day ranges must be given (e.g., 'days 1-7,' 'days 8-90'). For $0 amounts: state '$0 dollars.' Mark NON-COMPLIANT if missing 'dollars', time qualifiers, or incomplete coverage details. For non-compliant calls, include what the correct response should look like in the reason.",
          "example": "For inpatient hospital stays, you'll have a copay of $250 or $2.50 per day for days 1-5, and $0 per day for days 6 and beyond; it covers an unlimited number of days. The maximum out-of-pocket cost for inpatient hospital stays is $1,250 per stay. Your inpatient hospital copay is $0.",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "Inpatient Copay",
            "Coverage limits"
          ]
        },
        {
          "id": "7.2",
          "question": "Did the Agent accurately provide Medical Deductible, if present on the plan?",
          "context": "The agent must indicate the medical deductible if one is included on the plan. The agent must provide the medical deductible information exactly as stated in the Summary of Benefits. Refer to <PLAN_DETAILS.summary_of_benefits> section for more details. STRICT COMPLIANCE REQUIREMENTS: - If a medical deductible amount exists: Agent must state the exact dollar amount and include the word 'dollars' or 'dollar'. - If NO medical deductible exists: Agent MUST use the exact verbatim phrase 'This plan does not have a medical deductible' - CRITICAL: Stating '$0 deductible' or 'your deductible is $0' is NOT compliant when no deductible exist. - Mark as NON-COMPLIANT if agent says '$0 deductible' instead of the required exact phrase. - Mark as NON-COMPLIANT if agent fails to include 'dollars' or 'dollar' when stating an amount.",
          "example": "This plan has an annual medical deductible of $200. This means you'll need to pay $200 out-of-pocket for covered medical services before the plan's copayments or coinsurance start to apply.",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": []
        },
        {
          "id": "7.3",
          "question": "Did the agent accurately provide Primary Care Provider coverage and cost?",
          "context": "The agent must indicate coverage amount. If the copay/coinsurance is $0, the agent must still state as $0 copay/cost. If the cost is listed as a range, the agent must provide the complete range. Telehealth must be stated per Summary of Benefits for Primary Care.",
          "example": "Visits to your Primary Care Provider have a copay of $10 per visit. This applies to all in-network PCP visits. Your Primary Care Provider copay is $0.",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "PCP coverage",
            "PCP copay/coinsurance amount"
          ]
        },
        {
          "id": "7.4",
          "question": "Did the agent accurately provide Specialists coverage and cost?",
          "context": "The agent must indicate coverage amount. If the copay/coinsurance is $0, the agent must still state as $0 copay/cost. If the cost is listed as a range, the agent must provide the complete range. Specialist requires Prior Authorization or referral to be stated per Summary of Benefits.",
          "example": "Visits to in-network specialists have a copay of $40 per visit. Remember, you'll need a referral from your PCP for specialist visits under this plan. Your specialist copay is $0.",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "Specialist coverage",
            "Specialist copay/coinsurance amount"
          ]
        },
        {
          "id": "7.5",
          "question": "For Dual Special Needs Plans with SSBCI benefits, did the agent accurately explain the SSBCI benefit including qualification requirements?",
          "context": "Mark this as passed unless this is a DSNP plan",
          "example": "This plan includes Special Supplemental Benefits for the Chronically Ill, or SSBCI. To qualify for these benefits, you must meet certain criteria based on your chronic conditions. I want to make sure you understand that some SSBCI benefits may be counted as income by the Department of Housing and Urban Development, which could affect housing assistance if you receive it.",
          "weight": "LOW",
          "points": 1,
          "checkpoints": [
            "SSBCI benefit explained",
            "Qualification requirements stated",
            "HUD income disclaimer provided"
          ]
        }
      ]
    },
    {
      "section_number": 8,
      "section_name": "Benefit Review: Additional/Non Baseline Benefits",
      "max_points": 9,
      "items": [
        {
          "id": "8.1",
          "question": "Did the agent accurately provide complete benefit coverage, cost, and limits when discussed? (Rider benefit coverage scored here if applicable)",
          "context": "The agent must provide details on dental, vision, and hearing benefits including copays/coinsurance, visit limits, and maximum benefit allowances. If any benefit is discussed, the copay amount must also be given. Per the script: 'Discuss the costs/limitations on dental, vision, and hearing.' If additional benefits are reviewed, ALL limitations should be reviewed as well, such as allowances and frequencies on services. Rider benefit coverage is scored here if applicable.",
          "example": "This plan includes dental coverage with $0 copay for preventive services like cleanings and exams, and a $1000 annual allowance for comprehensive services. For vision, you have a $0 copay for annual eye exams and a $100 allowance for eyewear every two years. Hearing benefits include a $0 copay for annual hearing exams and up to $1000 for hearing aids every three years.",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "Dental benefits",
            "Hearing benefits",
            "Vision benefits",
            "Rider (if applicable)"
          ]
        },
        {
          "id": "8.2",
          "question": "Did the agent accurately provide complete Emergency & Urgent Care benefit coverage, cost, and limits?",
          "context": "The agent must provide copay/coinsurance for both Urgent Care and Emergency Care visits. Must include: - ER copay amount - Urgent Care copay amount - Waiver criteria (e.g., ER copay waived if admitted within 24 hours) - Domestic and international coverage information if applicable Per the script, Emergency Room (including the explanation) and Urgently Needed Services (including the definition) are required plan presentation items.",
          "example": "The copay for urgent care visits is $30. For emergency room visits, there's a $90 copay, which is waived if you're admitted to the hospital within 24 hours. These copays apply both domestically and internationally. Your emergency room copay is $0. Your urgent care copay is $0.",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "Emergency Room",
            "Urgent Care",
            "Urgent Care and/or Emergency Room: Waiver, domestic/international information (If applicable)"
          ]
        },
        {
          "id": "8.3",
          "question": "Did the agent accurately provide complete maximum out of pocket, Preventative & Mental Health benefit coverage, cost, and limits when discussed? Did the agent accurately provide complete benefit coverage, cost, and limits as listed in the summary of benefits for all other benefits if/when discussed?",
          "context": "The agent must provide: - Maximum Out-of-Pocket (MOOP): the annual limit - Preventative services: name 1-3 preventive services (e.g., flu shots, annual wellness visits, mammograms) and state $0 copay - Mental Health: copay/coinsurance for inpatient and outpatient mental health visits (CMS requires both to be presented) - Other benefits discussed by the client: Fitness Benefit, OTC/Healthy Food Benefit, Transportation, etc.",
          "example": "The maximum out-of-pocket limit for this plan is $3,400 per year. Preventive services like flu shots, annual wellness visits, and mammograms are covered at $0 copay. Mental health visits have a $40 copay. The plan also includes a $50 monthly allowance for over-the-counter items, a Silver Sneakers fitness membership, and 24 one-way trips for non-emergency medical transportation per year. Your preventative is $0 copay. Your Mental Health is $0 copay.",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "Maximum out of Pocket",
            "Preventative",
            "Mental Health",
            "Other benefits"
          ]
        }
      ]
    },
    {
      "section_number": 9,
      "section_name": "Premium and Payments",
      "max_points": 9,
      "items": [
        {
          "id": "9.1",
          "question": "Did the agent provide the plan premium as presented in the summary of benefits and indicate that it is in addition their Part B premium?",
          "context": "The agent must provide the full premium amount regardless of Medicaid or LIS subsidy status. The agent must state that the premium is in addition to the Medicare Part B premium, which the beneficiary must continue to pay. Per the script, during the enrollment signature section, the agent must confirm: 'Do you understand that you are enrolling in the plan [plan name] for a monthly premium of no more than [$ amount]?'",
          "example": "The monthly premium for this plan is $35. This is in addition to your Medicare Part B premium, which you must continue to pay. If you receive Extra Help, your premium may be lower.",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "Premium amount",
            "Part B disclosure"
          ]
        },
        {
          "id": "9.2",
          "question": "Did the agent provide all payment options, obtain the beneficiary's selection and read any applicable disclosures as they apply to selected payment methods?",
          "context": "The agent must read ALL payment options available on the enrollment platform and let the beneficiary choose. The payment options include: - Coupon book / Monthly bill - Pay from bank account - Social Security Check withholding - Railroad Retirement withholding The agent must read any applicable payment method disclaimers for the beneficiary's selected payment method. For example, if Social Security deduction is chosen, the agent should note: 'It may take up to 3 months for the Social Security deduction to begin, and you'll be billed directly until then.",
          "example": "You have several options for paying your premium: you can receive a monthly bill, have the amount deducted from your Social Security check, or set up automatic payments from your bank account. Which method would you prefer? [After selection] Please note that if you choose Social Security deduction, it may take up to 3 months to begin, and you'll be billed directly until then.",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "Payment Option",
            "Payment option disclosure (if applicable)"
          ]
        },
        {
          "id": "9.3",
          "question": "Did the agent read disclosures for Late Enrollment Penalty (LEP) Extra Help and Income Related Monthly Adjustment Amount (IRMAA)?",
          "context": "The agent must read all three disclosures: 1. **Late Enrollment Penalty (LEP):** 'If you didn't sign up for creditable prescription drug coverage when you first became eligible, you may have to pay a late enrollment penalty. If a penalty applies to you, we will send you a letter describing the steps you will need to take.' 2. **Extra Help:** 'People with limited incomes may qualify for Extra Help to pay for their prescription drug premiums and costs. If eligible, Medicare could pay for seventy-five (75) percent or more of your drug costs including monthly prescription drug premiums, annual deductibles, and coinsurance. Additionally, those who qualify will not be subject to the coverage gap or a late enrollment penalty. Many people are eligible for these savings and don't even know it.' 3. **IRMAA:** 'If you qualify, Medicare will pay all or part of your plan premium. If Medicare pays only a portion of this premium, we will bill you for the amount that Medicare doesn't cover. For more information, call the Social Security Administration at 1-800-772-1213.'",
          "example": "I need to inform you about a few important points. First, if you didn't sign up for creditable prescription drug coverage when you were first eligible, you may have to pay a late enrollment penalty. Second, if you have limited income, you might qualify for Extra Help to pay for your prescription drug costs. Lastly, if your income is above a certain amount, you may have to pay an additional fee called the Income Related Monthly Adjustment Amount or IRMAA.",
          "weight": "MEDIUM",
          "points": 2,
          "checkpoints": [
            "Late Enrollment Penalty",
            "Extra Help",
            "Income Related Monthly Adjustment Amount"
          ]
        },
        {
          "id": "9.4",
          "question": "If the plan includes a Part B premium reduction (Part B Giveback), did the agent accurately state the Part B Giveback benefit amount and explain how it works?",
          "context": "If Part B premium reduction is applicable to the plan, the agent must state the Part B Giveback amount and explain the benefit. The agent should explain that there may be a delay in the application of the Part B premium reduction, that it is not immediate and may take one or more payment cycles to realize the benefit, and that once the reduction takes effect, the back payment of reductions will be realized. The agent should also explain how reimbursement varies based on how Part B is paid (Social Security deduction vs. direct payment). This question only applies when the plan includes a Part B premium reduction benefit.",
          "example": "There may be a delay in the application of the Part B premium reduction. The Part B premium reduction is not immediate and may take one or more payment cycles to realize the benefit. Once the reduction takes effect, the back payment of reductions will be realized. For this plan, your Part B premium reduction will be $50, however that amount may change based on the amount you pay for Part B.",
          "weight": "LOW",
          "points": 1,
          "checkpoints": [
            "Part B Giveback amount stated",
            "Delay in application explained",
            "Reimbursement method explained"
          ]
        }
      ]
    },
    {
      "section_number": 10,
      "section_name": "Plan type education",
      "max_points": 3,
      "items": [
        {
          "id": "10.1",
          "question": "Did the agent accurately distinguish/explain the difference between the different plan types?",
          "context": "The agent must accurately distinguish between the types of plans available to the beneficiary and ensure that the beneficiary understands the differences. If the beneficiary expresses any misunderstanding, the agent must address it. The agent is not required to go over every plan type on every call --- but they should discuss the plan types the beneficiary asks about.",
          "example": "The plan we're discussing is a Medicare Advantage plan, which is different from Original Medicare or a Medicare Supplement plan. Medicare Advantage plans combine your Part A and B benefits, and usually include prescription drug coverage. They often offer additional benefits not covered by Original Medicare. Is this clear, or would you like me to explain further?",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": []
        }
      ]
    },
    {
      "section_number": 11,
      "section_name": "Plan Choice",
      "max_points": 3,
      "items": [
        {
          "id": "11.1",
          "question": "Did the agent verify the consumers plan choice and provide plan name with plan number and proposed effective date?",
          "context": "The agent provides plan name and PBP number and effective date of plan. Plan date should include month, day and year.",
          "example": "To confirm, you're choosing to enroll in the Humana Gold Plus H6622-037 (HMO) plan. The proposed effective date for this plan is January 1, 2025. Is this correct?",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "Plan Name & Number",
            "Effective Date"
          ]
        }
      ]
    },
    {
      "section_number": 12,
      "section_name": "Completing the enrollment",
      "max_points": 6,
      "items": [
        {
          "id": "12.1",
          "question": "Did the agent Confirm who will complete the enrollment?",
          "context": "If the beneficiary/applicant is the only party spoken to and reflects no cognitive impairment and does not indicate that someone else should be involved, then no additional confirmation is required that they will complete their own application.",
          "example": "Are you, [Customer Name], the person who will be completing this enrollment application?",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": []
        },
        {
          "id": "12.2",
          "question": "If applicable, did the agent follow processes for Authorized Representative/ Witness and collect demographics?",
          "context": "If Authorized Representative: Have the authorized representative state the name of the beneficiary and provide a clear attestation that they are authorized under state law to complete the application on the beneficiary's behalf. Obtain the Authorized Representative's required personal information, including their Relationship to the Applicant, First and Last Name, complete Address and Telephone Number.",
          "example": "You've indicated that you're the authorized representative for [Beneficiary Name]. Can you please state your full name, relationship to the applicant, complete address, and telephone number? Also, please confirm that you're authorized under state law to complete this application on behalf of [Beneficiary Name].",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": []
        }
      ]
    },
    {
      "section_number": 13,
      "section_name": "Application",
      "max_points": 9,
      "items": [
        {
          "id": "13.1",
          "question": "Did the Agent accurately collect and confirm demographic information?",
          "context": "The agent asks all questions on enrollment application, if HIPAA has not been verified the client should provide all demographic information. If HIPAA has been verified the agent can recite demographics and have beneficiary confirm it.",
          "example": "Confirm the beneficiary's first and last name. Confirm the beneficiary's date of birth. Confirm the beneficiary's physical address. \"Is your mailing address different than your permanent residential address?\"",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "Full Name",
            "DOB",
            "Physical Address",
            "Mailing-Address",
            "County"
          ]
        },
        {
          "id": "13.2",
          "question": "Did the Agent accurately collect Medicare and Medicaid information?",
          "context": "The agent asks the beneficiary for their Medicare Beneficiary Identifier (MBI), Parts A & B effective dates, and Medicaid number if applicable.",
          "example": null,
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "MBI & Parts A&B dates",
            "Medicaid Number"
          ]
        },
        {
          "id": "13.3",
          "question": "Did the Agent confirm PCP, chronic conditions, election period, and accessibility preferences?",
          "context": "The agent must confirm: - Primary Care Provider (PCP): 'Are you currently a patient of this provider?' - Chronic conditions (for SNP plans): verify qualifying condition - Valid Election Period: confirm the applicable enrollment period - Language and accessibility preferences",
          "example": "'Are you currently a patient of this provider?'",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "PCP",
            "Chronic Verification Provider",
            "Valid Election Period",
            "Language and Accessibility option"
          ]
        }
      ]
    },
    {
      "section_number": 14,
      "section_name": "Scripting and Disclosures",
      "max_points": 19,
      "items": [
        {
          "id": "14.1",
          "question": "Did the Agent provide the TPMO disclaimer as required?",
          "context": "The TPMO disclaimer must be said in the first minute of the call. The agent must state the summary of benefits and star rating availability, and that they do not offer every plan available in the area with the specific number of organizations and products. If the beneficiary chooses to do the text signature for enrollment, then this disclosure can be omitted. Mark NON-COMPLIANT if the TPMO disclaimer was not said within the first minute of the call.",
          "example": "You, the applicant acknowledge and agree to the following provisions.",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "TPMO disclaimer",
            "Was read during the first minute of the call"
          ]
        },
        {
          "id": "14.2",
          "question": "Did the Agent provide information about the Evidence of Coverage?",
          "context": "Agent must notify the beneficiary that they can receive the plan's evidence of coverage via mail upon request.",
          "example": "Upon request _______ will mail you the plan's Evidence of Coverage which includes rules you must follow to receive coverage on this plan",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "Evidence of Coverage"
          ]
        },
        {
          "id": "14.3",
          "question": "Did the Agent provide information about plan enrollment and coverage duration?",
          "context": "Will End Other MA/PDP: You can be in only one Medicare Advantage or Medicare Part D plan at a time, and your enrollment in this plan will automatically end your enrollment in another Medicare health plan or prescription drug plan. Entire Year/AEP/Special Circumstances: Enrollment in this plan is usually for an entire year.",
          "example": "If the beneficiary chooses to do the text signature for enrollment, then this disclosure can be omitted.",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "Will End Other MA/PDP",
            "Entire year/AEP/Special Circumstances"
          ]
        },
        {
          "id": "14.4",
          "question": "Did the Agent provide the required disclosure about the service area?",
          "context": "Service Area: (Plan name) provides plans for a specific service area. If you move to a new area, you will need to notify us and find a plan in your new area.",
          "example": "If the beneficiary chooses to do the text signature for enrollment, then this disclosure can be omitted.",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "Service Area"
          ]
        },
        {
          "id": "14.5",
          "question": "Did the Agent inform the beneficiary about their right to appeal and Medicare coverage outside the US?",
          "context": "Right to Appeal: Once you're a member, you have the right to appeal plan decisions. Medicare Outside US: Medicare doesn't generally cover beneficiaries out of the country, except for limited coverage near the U.S. border.",
          "example": "If the beneficiary chooses to do the text signature for enrollment, then this disclosure can be omitted.",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "Right to Appeal",
            "Medicare Outside US"
          ]
        },
        {
          "id": "14.6",
          "question": "Did the Agent disclose information about the release of beneficiary data, agent commission, accurate information, and Medicare A and/or B requirements?",
          "context": "Release of Information: By joining this Medicare Advantage Plan, you acknowledge that (Plan name) will share your information with Medicare and other plans as necessary. Agent Commission: If you receive help from a sales agent, broker, or other person employed by or contracted with (Plan name), they may be paid based on your enrollment. Accurate Information/Disenrollment: Information you have given us must be correct to the best of your knowledge. You may be disenrolled if you intentionally provide false information. Medicare A and/or B: You acknowledge that once enrolled, you must keep both Hospital (Part A) and Medical (Part B) to stay in (Plan name) (HMO D-SNP).",
          "example": "If the beneficiary chooses to do the text signature for enrollment, then this disclosure can be omitted.",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "Release of Information",
            "Agent Commission",
            "Accurate information/Disenrollment",
            "A and/or B"
          ]
        },
        {
          "id": "14.7",
          "question": "Did the agent review the Pre-Enrollment Checklist (PECL) with the beneficiary prior to completing the enrollment?",
          "context": "The agent must review the Pre-Enrollment Checklist (PECL) with the beneficiary before completing the enrollment. The PECL is a CMS-standardized document that covers important plan benefits, costs, rules, and how enrollment affects current coverage. ✓ PASS if the agent: - Walks through the PECL content with the beneficiary during the call - Confirms the beneficiary understands the information presented - Completes this review before submitting or finalizing the enrollment The PECL may be incorporated into the Summary of Benefits, built into the enrollment platform, or presented as a separate document. Regardless of format, the agent must actively review its contents with the beneficiary rather than simply asking if they received or read it independently. ✗ FAIL if: - The agent skips the PECL review entirely - The agent only asks if the beneficiary received or reviewed the PECL on their own without walking through it together - The PECL review occurs after the enrollment is completed or submitted - The agent does not confirm the beneficiary's understanding of the PECL items",
          "example": null,
          "weight": "LOW",
          "points": 1,
          "checkpoints": []
        }
      ]
    },
    {
      "section_number": 15,
      "section_name": "Agent Service & Call Closing",
      "max_points": 6,
      "items": [
        {
          "id": "15.1",
          "question": "Did the agent address all beneficiary's questions and concerns accurately, address confusion, avoid use of jargon, excessive hold time/dead air and ensure beneficiary has the cognitive ability to understand enrollment?",
          "context": "The agent must: - Address questions/concerns promptly and accurately - Use clear pace and tone matching the beneficiary's comprehension level - Manage hold times/dead air (minimize excessive holds) - Avoid jargon --- use simple language - Ensure cognitive abilities --- if the beneficiary seems confused, pause and re-explain - Provide accurate information at all times - Address confusion proactively: 'Do you have any questions about what we've discussed so far? I'm happy to explain anything in more detail.' If the beneficiary seems hesitant or confused, the agent should provide more clarity and actively listen to their concerns or hesitancy rather than pushing forward.",
          "example": "Throughout the call, the agent should respond to questions promptly and clearly, speak at an appropriate pace, minimize hold times, use simple language, and ensure the client understands. For instance: 'Do you have any questions about what we've discussed so far? I'm happy to explain anything in more detail if needed.' Do you want me to explain in more detail how the benefit works? What do you need more clarity on?",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "Address questions/concerns",
            "Pace and tone",
            "Hold times/Dead Air",
            "Jargon",
            "Cognitive Abilities",
            "Accurate Information",
            "Address confusion"
          ]
        },
        {
          "id": "15.2",
          "question": "Did the agent provide a call closing before disconnection?",
          "context": "Providing the client with the enrollment confirmation number, plan customer service or agent/agency phone number, cancellation notice disclaimer.",
          "example": "Thank you for enrolling today. Your enrollment confirmation number is 12345. If you have any questions, you can reach our member care department at 888-596-1830. You may receive a cancellation call from your current carrier, which is normal and won't take effect until the end of the month.",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": [
            "Confirmation Number",
            "Contact Information",
            "Cancellation notice"
          ]
        }
      ]
    },
    {
      "section_number": 16,
      "section_name": "Agreement to Enroll",
      "max_points": 9,
      "items": [
        {
          "id": "16.1",
          "question": "Did the agent confirm the consumers understanding of the enrollment information and process?",
          "context": "Agent must ensure beneficiary understands that they are completing an application and that agreeing to submit the application will result in enrollment.",
          "example": "Do you understand that by agreeing to submit this application, you will be enrolled in the Humana Gold Plus H6622-037 (HMO) plan, effective January 1, 2025? Do you have any questions about the enrollment process or the information we've discussed?",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": []
        },
        {
          "id": "16.2",
          "question": "Did the agent obtain the beneficiary's agreement to enroll/submit the application?",
          "context": "Make sure the agent reads this exactly 'If you agree to complete your enrollment now, please state your name, your date of birth, and that you agree.' A yes response must be given. If the beneficiary chooses to do the text signature for enrollment, then this disclosure can be omitted.",
          "example": "If you agree to complete your enrollment now, please state your name, your date of birth, and say 'I agree to enroll in the Humana Gold Plus H6622-037 (HMO) plan.'",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": []
        },
        {
          "id": "16.3",
          "question": "Did the agent confirm the beneficiary's intent to enroll into the plan?",
          "context": "The agent needs to clarify and make sure the beneficiary wants to move forward with filling out a telephonic application. For AmeriHealth plans, the agent needs to tell the beneficiary to call them back to enroll in the plan. This needs to happen before the agent starts reading the enrollment application.",
          "example": "\"Just to be clear you want to sign up for this plan?\"",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": []
        }
      ]
    },
    {
      "section_number": 17,
      "section_name": "Critical Elements",
      "max_points": 15,
      "items": [
        {
          "id": "17.1",
          "question": "Did the Agent conduct a needs assessment?",
          "context": "Did the agent conduct a needs assessment that includes specific inquiry into durable medical equipment (DME) and physical therapy (PT)? ✓ PASS if the agent: - Asks what is most important to the client in a Medicare plan - Specifically asks whether the beneficiary currently uses or anticipates needing durable medical equipment (DME) such as wheelchairs, oxygen, or CPAP machines - Specifically asks whether the beneficiary currently receives or anticipates needing physical therapy (PT) - Completes all three inquiries before making any plan recommendation The agent does not need to use exact wording, but must clearly address DME and PT as distinct topics. Asking only about 'general health needs' or 'medical equipment' without specifically mentioning DME or PT does not satisfy this requirement. ✗ FAIL if the agent: - Skips the needs assessment entirely - Fails to ask about DME use (current or anticipated) - Fails to ask about PT needs (current or anticipated) - Makes a plan recommendation before completing the needs assessment - Only asks about general health needs without specifically addressing both DME and PT as separate topics",
          "example": "Before we discuss specific plans, can you tell me what's most important to you in a Medicare plan? Are there any specific benefits or services you're particularly interested in?",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": []
        },
        {
          "id": "17.2",
          "question": "Did the Agent avoid using superlatives?",
          "context": "Avoid using superlatives when describing plans, networks, formularies, etc. (best, biggest, largest, etc.). It is permissible for agents to make a comparison and state that the plan is much stronger than the current plan the beneficiary has.",
          "example": "This plan has a broad network of providers and covers many prescription drugs. It may be a good fit for your needs based on what you've told me. This plan is a stronger plan; this plan is the most and strongest plan. This plan is a suitable for you.",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": []
        },
        {
          "id": "17.3",
          "question": "Did the agent refrain from selecting only favorable or leading information to present to the beneficiary?",
          "context": "Avoid negative comments/impressions including those about Medicare, CMS, or other carriers/plans. The agent should NOT agree with negative comments made by the beneficiary about competitors or Medicare itself. If the beneficiary makes negative statements about their current plan, the agent should redirect to discussing plan features rather than criticizing competitors. Examples of prohibited statements: 'Yes, that carrier is terrible', 'Medicare doesn't care about beneficiaries', 'Your current plan is ripping you off.' This applies ONLY to the agent's behavior, not the beneficiary's. If the beneficiary says something negative, that is acceptable --- but the agent must not agree with or amplify it.",
          "example": null,
          "weight": "HIGH",
          "points": 3,
          "checkpoints": []
        },
        {
          "id": "17.4",
          "question": "Did the agent avoid claiming to be endorsed by AARP or other companies? If applicable*",
          "context": "Avoid indicating AARP, NCOA, or other organization endorsement of MA, MAPD, or PDP plans. Agents cannot imply that any third-party organization endorses or recommends a specific plan. This includes statements like 'This is the plan AARP recommends' or 'This plan is backed by [organization name].",
          "example": null,
          "weight": "HIGH",
          "points": 3,
          "checkpoints": []
        },
        {
          "id": "17.5",
          "question": "Did the agent avoid unprofessional/inappropriate language and negative comments about Medicare or other companies.",
          "context": "Avoid negative comments/impressions including those about Medicare, CMS, or other carriers/plans. Agent should not agree with negative comments made by the beneficiary about competitors or Medicare itself. If beneficiary makes negative statements about their current plan, agent should redirect to discussing plan features rather than criticizing competitors. Examples of prohibited statements: 'Yes, that carrier is terrible,' 'Medicare doesn't care about beneficiaries,' 'Your current plan is ripping you off.' This applies only to the agent, not the beneficiary. It is ok if the beneficiary says something bad.",
          "example": "Each Medicare plan has its own strengths and is designed to meet different needs. While this plan might be a good fit for you based on what you've told me, other plans could be better suited for people with different circumstances.",
          "weight": "HIGH",
          "points": 3,
          "checkpoints": []
        }
      ]
    }
  ]
}
$scorecard$::jsonb
on conflict (version) do nothing;


-- ---------------------------------------------------------------------------
-- Medicare leaderboard: agents ranked by average scorecard percentage.
--
-- Separate from scoring_leaderboard(), which ranks on the rubric's 0-100
-- coaching score across every call. This one only counts calls that have a
-- scorecard grade, and follows the same conventions so the two read alike:
--   - the call's CURRENT agent and team (migrations 013, 019), not whoever
--     was assigned when it was graded;
--   - one grade per call, the latest (migration 031);
--   - a reviewer's regrade wins over the model's grade (migration 007).
-- A call where every item was N/A has no percentage and is left out.
-- ---------------------------------------------------------------------------
create or replace function public.scorecard_leaderboard(p_start date, p_end date)
returns table (
  agent_id        uuid,
  full_name       text,
  team_name       text,
  calls_scored    bigint,
  avg_score       numeric,
  calls_reviewed  bigint,
  rank            bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with graded as (
    select
      r.agent_id,
      r.agent_name,
      coalesce(rt.name, pt.name, '— unassigned —') as team_name,
      case when c.manual_items is not null then c.manual_percent else c.percent end as percent,
      (c.manual_items is not null) as reviewed
    from public.call_scorecards c
    join public.call_recordings r on r.id = c.recording_id
    left join public.teams rt     on rt.id = r.team_id
    left join public.profiles p   on p.id = r.agent_id
    left join public.teams pt     on pt.id = p.team_id
    where r.call_on between p_start and p_end
      and c.id = (
        select c2.id
        from public.call_scorecards c2
        where c2.recording_id = c.recording_id
        order by c2.created_at desc, c2.id desc
        limit 1
      )
  ),
  real_agents as (
    select
      g.agent_id,
      p.full_name,
      g.team_name,
      count(*)                           as calls_scored,
      round(avg(g.percent), 1)           as avg_score,
      count(*) filter (where g.reviewed) as calls_reviewed
    from graded g
    join public.profiles p on p.id = g.agent_id and p.active
    where g.percent is not null
    group by g.agent_id, p.full_name, g.team_name
  ),
  labeled as (
    select
      null::uuid                         as agent_id,
      g.agent_name                       as full_name,
      g.team_name,
      count(*)                           as calls_scored,
      round(avg(g.percent), 1)           as avg_score,
      count(*) filter (where g.reviewed) as calls_reviewed
    from graded g
    where g.agent_id is null and g.agent_name is not null and g.percent is not null
    group by g.agent_name, g.team_name
  ),
  totals as (
    select * from real_agents
    union all
    select * from labeled
  )
  select
    agent_id, full_name, team_name, calls_scored, avg_score, calls_reviewed,
    rank() over (order by avg_score desc nulls last)
  from totals
  order by avg_score desc nulls last, full_name;
$$;

grant execute on function public.scorecard_leaderboard(date, date) to authenticated;
