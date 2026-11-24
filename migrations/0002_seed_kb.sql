-- Demo knowledge base. Business users edit all of the free text on /admin;
-- the JSON columns are the "Technical" tab and normally never need touching.

INSERT INTO kb_transaction_types (id, key, name, description, process_guide, fields_schema, is_active, sort_order) VALUES (
  1,
  'leave_application',
  'Leave application',
  'Use this when a staff member wants to apply for leave or record time off: sick days, a day off agreed with their supervisor, unpaid leave, or any other absence from work.',
  'Every leave application needs the first and last day of leave and the number of working days taken.
Apply as early as you can. For leave that has already been taken, apply within 3 working days of returning to work.
Weekends and public holidays are not counted as leave days.
One application covers one continuous period. If you were away on two separate occasions, make two applications.
Your supervisor is the first person to ask about anything unusual. HR has the final say.',
  '{"type":"object","properties":{"start_date":{"type":"string","format":"date","title":"First day of leave","description":"First day of leave, as YYYY-MM-DD"},"end_date":{"type":"string","format":"date","title":"Last day of leave","description":"Last day of leave, as YYYY-MM-DD (same as the first day for a single day)"},"days":{"type":"number","exclusiveMinimum":0,"title":"Number of leave days","description":"Working days of leave taken; 0.5 for a half day"}},"required":["start_date","end_date","days"]}',
  1,
  10
);

INSERT INTO kb_reasons (id, type_id, code, label, process_guide, evidence_rule, max_days, extra_fields_schema, is_active, sort_order) VALUES
(
  1, 1, 'medical', 'Medical leave',
  'For days when you are unwell and unable to work.

1. Inform your supervisor on the same day you are unwell, before your shift starts if you can. A WhatsApp message or a call is fine.
2. See a registered clinic or doctor and get a medical certificate (MC).
3. Send a clear photo of the MC within 2 working days of returning to work.

The MC must show your name, the clinic, the doctor''s name and signature, and the dates you were given leave. The dates on the MC must cover the days you are applying for. If the photo is blurry or cut off, we will ask you to send it again.

An MC from a traditional Chinese medicine practitioner is not accepted for medical leave. Ask HR if you are unsure whether your clinic is registered.',
  'required', 14,
  '{"type":"object","properties":{"clinic":{"type":"string","title":"Clinic","description":"Name of the clinic or hospital on the MC"},"doctor":{"type":"string","title":"Doctor","description":"Doctor''s name on the MC"},"mc_number":{"type":"string","title":"MC number","description":"Serial or reference number printed on the MC, if there is one"}},"required":["clinic","doctor"]}',
  1, 10
),
(
  2, 1, 'supervisor_granted_off', 'Off granted by supervisor',
  'For an off day that your direct supervisor has agreed to give you, for example time off in lieu after working extra hours.

1. Ask your direct supervisor on WhatsApp at least 1 day before the off day.
2. Your supervisor must reply clearly approving the specific date or dates. A thumbs-up on its own is not enough; the reply should say the date.
3. Send a screenshot of that chat.

The screenshot must show your supervisor''s name, the date or dates, and their approval. If your supervisor approved it verbally, ask them to confirm it on WhatsApp first and then send the screenshot.',
  'required', 3,
  '{"type":"object","properties":{"supervisor_name":{"type":"string","title":"Supervisor","description":"Name of the supervisor who approved"},"approval_date":{"type":"string","format":"date","title":"Date approval was given","description":"Date the supervisor gave the approval, as YYYY-MM-DD"}},"required":["supervisor_name","approval_date"]}',
  1, 20
),
(
  3, 1, 'no_pay_leave', 'No pay leave',
  'Unpaid leave, for when you need time off and have no paid leave that covers it.

1. Discuss it with your supervisor first.
2. Ask for approval on WhatsApp, stating the dates and that it is no pay leave.
3. Your supervisor must reply approving it.
4. Send a screenshot showing the approval.

The screenshot must show your supervisor''s name, the dates, that it is no pay leave, and the approval.
No pay leave cannot exceed 5 consecutive days without HR''s approval. For a longer period, speak to HR before applying.',
  'required', 5,
  '{"type":"object","properties":{"supervisor_name":{"type":"string","title":"Supervisor","description":"Name of the supervisor who approved"},"approval_date":{"type":"string","format":"date","title":"Date approval was given","description":"Date the supervisor gave the approval, as YYYY-MM-DD"}},"required":["supervisor_name","approval_date"]}',
  1, 30
),
(
  4, 1, 'others', 'Others',
  'For leave that does not fit any of the other reasons. Use this only when none of the specific reasons applies.

Describe your reason in your own words. You may send any document that supports it, such as a letter or an appointment card, but it is not compulsory.
HR will review the request before it is approved, so it will show as pending until then. HR may contact you for more details.',
  'optional', NULL,
  '{"type":"object","properties":{"reason_description":{"type":"string","title":"Reason, in the staff member''s own words","description":"A short summary of the user''s reason, confirmed with the user"}},"required":["reason_description"]}',
  1, 90
);

INSERT INTO kb_articles (id, title, content, tags, is_active, sort_order) VALUES
(
  1, 'Leave policy',
  'Annual entitlements for full-time staff:
- Medical leave: 14 days a year. A medical certificate (MC) is needed for every day taken.
- Off days granted by a supervisor: given case by case, usually in lieu of extra hours worked. Each off day comes out of your off-day balance.
- No pay leave: unpaid. Up to 5 consecutive days with your supervisor''s approval; anything longer needs HR''s approval.

Leave is counted in working days. Half days are allowed and count as 0.5.
Unused medical leave cannot be carried forward or paid out.
Taking leave without applying, or without the approval a leave type requires, is treated as absence without leave.',
  'leave, policy, entitlement', 1, 10
),
(
  2, 'Who to contact',
  'Your direct supervisor is the first person to ask about leave, shifts and approvals.
HR handles balances, pay questions, long absences and anything your supervisor cannot decide.
HR office hours are Monday to Friday, 9am to 6pm. Email hr@example.com or call the HR desk on extension 100.
In an emergency outside office hours, call your supervisor directly.',
  'contact, HR, supervisor', 1, 20
),
(
  3, 'Using this WhatsApp assistant',
  'You can apply for leave by chatting here. Say what you need in your own words and the assistant will guide you through the steps and tell you what to send.
You can send a photo or a PDF as evidence, for example a medical certificate or a screenshot of your supervisor''s approval.
Nothing is submitted until the assistant shows you a summary and you reply YES.
Send /cancel to drop the request you are working on. Send /reset to start the conversation again from scratch.',
  'help, how to', 1, 30
);
