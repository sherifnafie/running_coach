/**
 * Built-in presentation labels; athlete/coach content is never machine-rewritten by the shell.
 *
 * English is the source. Dutch and Arabic have curated tables. Every other language gets a generated label pack
 * (`setLabelPack`), produced once per language by the server and cached; until it arrives, labels stay English.
 */
export type ShellLanguage = 'en' | 'nl' | 'ar';
export function shellLanguage(locale: string): ShellLanguage {
  const language = locale.toLowerCase().split('-')[0];
  return language === 'ar' || language === 'nl' ? language : 'en';
}

/** Languages with a curated table (no generated pack needed). */
export function hasCuratedLabels(locale: string): boolean {
  return ['en', 'nl', 'ar'].includes(labelLanguage(locale));
}

/**
 * The key a generated label pack is stored under: the primary language subtag, plus the script for Chinese
 * (Traditional for TW/HK/MO), e.g. "de", "pt", "zh-hans", "zh-hant". Invalid input yields "en".
 */
export function labelLanguage(locale: string): string {
  const parts = locale.trim().toLowerCase().replace(/_/g, '-').split('-');
  const primary = parts[0] ?? '';
  if (!/^[a-z]{2,3}$/.test(primary)) return 'en';
  if (primary === 'zh') return parts.some((p) => ['hant', 'tw', 'hk', 'mo'].includes(p)) ? 'zh-hant' : 'zh-hans';
  if (primary === 'iw') return 'he';
  if (primary === 'no' || primary === 'nn') return 'nb';
  return primary;
}

const RTL = /^(ar|he|iw|fa|ur|ps|sd|ug|yi|dv|ckb|syr|arc|ku-arab|pa-arab)(-|$)/i;
export function languageDirection(locale: string): 'ltr' | 'rtl' {
  try {
    const info = new Intl.Locale(locale) as Intl.Locale & { getTextInfo?: () => { direction?: string }; textInfo?: { direction?: string } };
    const direction = info.getTextInfo?.().direction ?? info.textInfo?.direction;
    if (direction === 'rtl' || direction === 'ltr') return direction;
  } catch {
    /* fall back to the list below */
  }
  return RTL.test(locale) ? 'rtl' : 'ltr';
}

const packs = new Map<string, Record<string, string>>();
/** Install generated labels for a language (English source text → translation). */
export function setLabelPack(language: string, labels: Record<string, string>): void {
  packs.set(labelLanguage(language), labels);
}
export function labelPack(locale: string): Record<string, string> | undefined {
  return packs.get(labelLanguage(locale));
}

const labels: Record<string, [string, string]> = {
  "of": ["van", "من"],
  "Pick a new day for": ["Kies een nieuwe dag voor", "اختر يومًا جديدًا لـ"],
  "Moved to": ["Verplaatst naar", "نُقلت إلى"],
  "Settings": ["Instellingen", "الإعدادات"],
  "Chat": ["Chat", "الدردشة"],
  "Today": ["Vandaag", "اليوم"],
  "Calendar": ["Kalender", "التقويم"],
  "Plan": ["Plan", "الخطة"],
  "Progress": ["Voortgang", "التقدم"],
  "More": ["Meer", "المزيد"],
  "Light": ["Licht", "فاتح"],
  "Dark": ["Donker", "داكن"],
  "Default": ["Standaard", "الافتراضي"],
  "Confirm": ["Bevestigen", "تأكيد"],
  "Cancel": ["Annuleren", "إلغاء"],
  "Send": ["Versturen", "إرسال"],
  "Loading": ["Laden", "جارٍ التحميل"],
  "Retry": ["Opnieuw", "إعادة المحاولة"],
  "Your coach will fill this in": ["Je coach vult dit in", "سيملأ مدربك هذا القسم"],
  "After your first chat, today's session shows up here.": ["Na je eerste gesprek verschijnt hier je training voor vandaag.", "بعد أول محادثة، تظهر حصة اليوم هنا."],
  "Say hi to your coach": ["Begroet je coach", "رحب بمدربك"],
  "Today's sessions": ["Trainingen van vandaag", "حصص اليوم"],
  "Quick check-in": ["Korte check-in", "تقييم سريع"],
  "Helps your coach adjust the plan.": ["Helpt je coach het plan aan te passen.", "يساعد مدربك على تعديل الخطة."],
  "How are you feeling?": ["Hoe voel je je?", "كيف تشعر؟"],
  "Save check-in": ["Check-in opslaan", "حفظ التقييم"],
  "Last activity": ["Laatste activiteit", "آخر نشاط"],
  "Distance": ["Afstand", "المسافة"],
  "Time": ["Tijd", "الوقت"],
  "Pace": ["Tempo", "الوتيرة"],
  "Next key session": ["Volgende belangrijke training", "الحصة المهمة التالية"],
  "Mark done": ["Afronden", "تمت"],
  "Skip": ["Overslaan", "تخطي"],
  "Undo": ["Ongedaan maken", "تراجع"],
  "Ask coach": ["Vraag je coach", "اسأل المدرب"],
  "Done": ["Gedaan", "مكتمل"],
  "Skipped": ["Overgeslagen", "متخطى"],
  "Planned": ["Gepland", "مخطط"],
  "Now": ["Nu", "الآن"],
  "Nice work. Logged.": ["Goed gedaan. Opgeslagen.", "أحسنت. تم التسجيل."],
  "Hi coach! Can you build my plan?": ["Hoi coach! Kun je mijn plan maken?", "مرحبًا مدربي! هل يمكنك إعداد خطتي؟"],
  "I have a question about my plan: ": ["Ik heb een vraag over mijn plan: ", "لدي سؤال عن خطتي: "],
  "Discuss this plan": ["Bespreek dit plan", "ناقش هذه الخطة"],
  "Why this plan": ["Waarom dit plan", "لماذا هذه الخطة"],
  "Planned volume by week": ["Gepland volume per week", "الحجم المخطط أسبوعيًا"],
  "Week of": ["Week van", "أسبوع"],
  "Runs": ["Trainingen", "مرات الجري"],
  "Longest": ["Langste", "الأطول"],
  "Key sessions": ["Belangrijke trainingen", "الحصص المهمة"],
  "Calendar layout": ["Kalenderweergave", "عرض التقويم"],
  "Month": ["Maand", "شهر"],
  "Week": ["Week", "أسبوع"],
  "Key": ["Legenda", "المفتاح"],
  "Colour and letter show the type. Solid means done.": ["Kleur en letter tonen het type. Ingekleurd betekent afgerond.", "اللون والحرف يدلان على النوع. اللون الكامل يعني مكتملًا."],
  "Nothing here yet. Your coach will fill this in after your first chat.": ["Nog niets hier. Je coach vult dit in na je eerste gesprek.", "لا شيء هنا بعد. سيملأ مدربك هذا القسم بعد أول محادثة."],
  "Run": ["Hardlopen", "جري"],
  "Easy": ["Rustig", "سهل"],
  "Long run": ["Lange duurloop", "جري طويل"],
  "Tempo": ["Tempo", "جري وتيرة"],
  "Intervals": ["Intervallen", "فترات"],
  "Hills": ["Heuvels", "تلال"],
  "Race": ["Wedstrijd", "سباق"],
  "Strength": ["Kracht", "قوة"],
  "Cross-training": ["Crosstraining", "تدريب متنوع"],
  "Moved": ["Verplaatst", "منقول"],
  "Planned weekly volume": ["Gepland weekvolume", "الحجم الأسبوعي المخطط"],
  "Hi coach! Where do we start?": ["Hoi coach! Waar beginnen we?", "مرحبًا مدربي! من أين نبدأ؟"],
  "Nothing planned today": ["Vandaag niets gepland", "لا حصة مخططة اليوم"],
  "Enjoy the day. Ask your coach if you want to add something.": ["Geniet van je dag. Vraag je coach als je iets wilt toevoegen.", "استمتع بيومك. اسأل مدربك إذا أردت إضافة شيء."],
  "Couldn't save that. Try again.": ["Opslaan mislukt. Probeer opnieuw.", "تعذر الحفظ. حاول مجددًا."],
  "Add to today’s check-in": ["Aan de check-in van vandaag toevoegen", "إضافة إلى تقييم اليوم"],
  "Energy": ["Energie", "الطاقة"],
  "Drained": ["Uitgeput", "منهك"],
  "Great": ["Geweldig", "ممتاز"],
  "Sleep last night": ["Slaap afgelopen nacht", "النوم ليلة أمس"],
  "Poor": ["Slecht", "سيئ"],
  "Anything hurting?": ["Ergens pijn?", "هل لديك ألم؟"],
  "Anything else?": ["Nog iets anders?", "أي شيء آخر؟"],
  "Pick at least one answer.": ["Kies minstens één antwoord.", "اختر إجابة واحدة على الأقل."],
  "Thanks, saved.": ["Bedankt, opgeslagen.", "شكرًا، تم الحفظ."],
  "Couldn't save your check-in.": ["Check-in opslaan mislukt.", "تعذر حفظ تقييمك."],
  "Easy run": ["Rustige loop", "جري سهل"],
  "Rest day": ["Rustdag", "يوم راحة"],
  "Workout": ["Training", "تمرين"],
  "Partly done": ["Deels gedaan", "مكتمل جزئيًا"],
  "Ask coach about this": ["Vraag je coach hierover", "اسأل المدرب عن هذا"],
  "Race week": ["Wedstrijdweek", "أسبوع السباق"],
  "Read-only. Ask your coach to change anything.": ["Alleen lezen. Vraag je coach om iets te wijzigen.", "للعرض فقط. اطلب من مدربك أي تعديل."],
  "After your first chat you'll see your training block, weekly volume and key sessions here.": ["Na je eerste gesprek zie je hier je trainingsblok, weekvolume en belangrijke trainingen.", "بعد أول محادثة، سترى هنا خطتك وحجم التدريب الأسبوعي والحصص المهمة."],
  "Start the conversation": ["Begin het gesprek", "ابدأ المحادثة"],
  "weeks": ["weken", "أسابيع"],
  "Planned distance per week": ["Geplande afstand per week", "المسافة المخططة أسبوعيًا"],
  "No planned runs in this period yet.": ["Nog geen trainingen gepland in deze periode.", "لا جري مخطط في هذه الفترة بعد."],
  "Goal race": ["Doelwedstrijd", "السباق المستهدف"],
  "Ask your coach to explain the purpose of this plan.": ["Vraag je coach om het doel van dit plan uit te leggen.", "اطلب من مدربك شرح هدف هذه الخطة."],
  "Time range": ["Periode", "الفترة الزمنية"],
  "8 wk": ["8 wk", "8 أسابيع"],
  "12 wk": ["12 wk", "12 أسبوعًا"],
  "16 wk": ["16 wk", "16 أسبوعًا"],
  "Once you've logged a few runs, your weekly volume and trends show up here.": ["Na een paar geregistreerde trainingen verschijnen hier je weekvolume en trends.", "بعد تسجيل عدة مرات من الجري، تظهر هنا أحجام التدريب الأسبوعية واتجاهاته."],
  "This week": ["Deze week", "هذا الأسبوع"],
  "vs last week": ["t.o.v. vorige week", "مقارنة بالأسبوع الماضي"],
  "Weekly distance": ["Weekafstand", "المسافة الأسبوعية"],
  "Distance run per week": ["Gelopen afstand per week", "مسافة الجري أسبوعيًا"],
  "No runs in this period yet.": ["Nog geen trainingen in deze periode.", "لا جري في هذه الفترة بعد."],
  "Longest run each week": ["Langste loop per week", "أطول جري في كل أسبوع"],
  "Longest run per week": ["Langste loop per week", "أطول جري أسبوعيًا"],
  "Your long runs will show up here.": ["Je lange duurlopen verschijnen hier.", "تظهر هنا مرات الجري الطويلة."],
  "Easy-run pace": ["Tempo van rustige lopen", "وتيرة الجري السهل"],
  "Easy runs with heart rate. Faster at the same effort is a good sign.": ["Rustige lopen met hartslaggegevens. Sneller bij dezelfde inspanning is een goed teken.", "الجري السهل مع بيانات النبض. السرعة الأعلى بالجهد نفسه مؤشر جيد."],
  "Pace of easy runs": ["Tempo van rustige lopen", "وتيرة الجري السهل"],
  "Needs a few easy runs with heart-rate data.": ["Een paar rustige lopen met hartslaggegevens nodig.", "يحتاج إلى عدة مرات جري سهلة مع بيانات النبض."],
  "Consistency": ["Regelmaat", "الانتظام"],
  "Weeks with 3 or more runs": ["Weken met 3 of meer trainingen", "أسابيع فيها 3 مرات جري أو أكثر"],
  "Missed weeks happen. What counts is the pattern over months.": ["Een week missen gebeurt. Het patroon over maanden telt.", "قد تفوتك بعض الأسابيع. الأهم هو الانتظام على مدى الأشهر."],
  "Race results": ["Wedstrijdresultaten", "نتائج السباقات"],
  "No race results yet.": ["Nog geen wedstrijdresultaten.", "لا نتائج سباقات بعد."],
  "Cross-train": ["Crosstraining", "تدريب متنوع"],
  "Tomorrow": ["Morgen", "غدًا"],
  "Yesterday": ["Gisteren", "أمس"],
  "is typing…": ["typt…", "يكتب…"],
  "is thinking…": ["denkt na…", "يفكر…"],
  "is working on it…": ["werkt eraan…", "يعمل على ذلك…"],
  "Previous month": ["Vorige maand", "الشهر السابق"],
  "Next month": ["Volgende maand", "الشهر التالي"],
  "Previous week": ["Vorige week", "الأسبوع السابق"],
  "Next week": ["Volgende week", "الأسبوع التالي"],
  "Nothing planned.": ["Niets gepland.", "لا شيء مخطط."],
  "Nothing planned": ["Niets gepland", "لا شيء مخطط"],
  "Couldn’t load this section. Your coach has been told.": ["Dit onderdeel kon niet laden. Je coach is op de hoogte gebracht.", "تعذر تحميل هذا القسم. تم إبلاغ مدربك."],
  "Move here": ["Hierheen verplaatsen", "انقل إلى هنا"],
  "Selected workout": ["Geselecteerde training", "التمرين المحدد"],
  "Move": ["Verplaatsen", "نقل"],
  "About this session": ["Over deze training", "حول هذه الحصة"],
  "About today's session": ["Over de training van vandaag", "حول حصة اليوم"],
  "After your first chat you'll see your training block, weekly training and key sessions here.": ["Na je eerste gesprek zie je hier je trainingsblok, je wekelijkse training en belangrijke trainingen.", "بعد أول محادثة، سترى هنا خطتك وتدريبك الأسبوعي والحصص المهمة."],
  "Avg HR": ["Gem. hartslag", "متوسط النبض"],
  "Bike": ["Fietsen", "دراجة"],
  "Climb": ["Klimmen", "تسلق"],
  "Competition": ["Wedstrijd", "منافسة"],
  "Conditioning": ["Conditie", "لياقة"],
  "Distance per week, by sport": ["Afstand per week, per sport", "المسافة أسبوعيًا حسب الرياضة"],
  "Effort": ["Inspanning", "الجهد"],
  "Estimated 1RM per week": ["Geschatte 1RM per week", "الحد الأقصى المقدّر أسبوعيًا"],
  "Estimated 1RM per week from your working sets (up to 10 reps). An estimate, not a tested max.": ["Geschatte 1RM per week uit je werksets (tot 10 herhalingen). Een schatting, geen geteste max.", "الحد الأقصى لتكرار واحد مقدّرًا أسبوعيًا من مجموعاتك (حتى 10 تكرارات). تقدير وليس حدًا مختبرًا."],
  "Goal": ["Doel", "الهدف"],
  "Heavy": ["Zwaar", "ثقيل"],
  "Hike": ["Wandeltocht", "مشي جبلي"],
  "Hypertrophy": ["Spieropbouw", "تضخيم"],
  "Key session": ["Belangrijke training", "حصة مهمة"],
  "Long": ["Lang", "طويل"],
  "Longest session": ["Langste training", "أطول حصة"],
  "Meet": ["Wedstrijd", "بطولة"],
  "Mobility": ["Mobiliteit", "مرونة"],
  "Next goal": ["Volgend doel", "الهدف التالي"],
  "No lifts in this period yet.": ["Nog geen krachttraining in deze periode.", "لا تمارين قوة في هذه الفترة بعد."],
  "No planned sessions in this period yet.": ["Nog geen trainingen gepland in deze periode.", "لا حصص مخططة في هذه الفترة بعد."],
  "No results yet.": ["Nog geen resultaten.", "لا نتائج بعد."],
  "No sessions in this period yet.": ["Nog geen trainingen in deze periode.", "لا حصص في هذه الفترة بعد."],
  "Once you've logged a few sessions, your weekly training and trends show up here.": ["Na een paar geregistreerde trainingen verschijnen hier je weektraining en trends.", "بعد تسجيل عدة حصص، يظهر هنا تدريبك الأسبوعي واتجاهاته."],
  "Other": ["Overig", "أخرى"],
  "Planned sessions done": ["Geplande trainingen gedaan", "الحصص المخططة المنجزة"],
  "Planned training by week": ["Geplande training per week", "التدريب المخطط أسبوعيًا"],
  "Planned training time per week": ["Geplande trainingstijd per week", "وقت التدريب المخطط أسبوعيًا"],
  "Planned weekly training": ["Geplande weektraining", "التدريب الأسبوعي المخطط"],
  "Power": ["Explosiviteit", "قدرة"],
  "Priority": ["Prioriteit", "الأولوية"],
  "Recovery": ["Herstel", "استشفاء"],
  "Rest": ["Rust", "راحة"],
  "Result": ["Resultaat", "النتيجة"],
  "Results": ["Resultaten", "النتائج"],
  "Row": ["Roeien", "تجديف"],
  "Sessions": ["Trainingen", "الحصص"],
  "Sets": ["Sets", "المجموعات"],
  "Skill": ["Vaardigheid", "مهارة"],
  "Sport": ["Sport", "الرياضة"],
  "Swim": ["Zwemmen", "سباحة"],
  "Technique": ["Techniek", "تقنية"],
  "Test": ["Test", "اختبار"],
  "Top set": ["Zwaarste set", "أثقل مجموعة"],
  "Training time per week, by sport": ["Trainingstijd per week, per sport", "وقت التدريب أسبوعيًا حسب الرياضة"],
  "Walk": ["Wandelen", "مشي"],
  "Weekly training time": ["Trainingstijd per week", "وقت التدريب الأسبوعي"],
  "Weeks with 2 or more sessions": ["Weken met 2 of meer trainingen", "أسابيع فيها حصتان أو أكثر"],
  "Yoga": ["Yoga", "يوغا"],
  "set": ["set", "مجموعة"],
  "sets": ["sets", "مجموعات"],
  "top": ["zwaarst", "الأثقل"],
  "week to go": ["week te gaan", "أسبوع متبقٍ"],
  "weeks to go": ["weken te gaan", "أسابيع متبقية"]
};
/** English source strings of the kit labels (the server generates packs from these plus the shell labels). */
export const kitLabelSources: readonly string[] = Object.keys(labels);

export function translate(text: string, locale: string, extra?: Record<string, [string, string]>): string {
  const language = labelLanguage(locale);
  if (language === 'en') return text;
  if (language === 'nl' || language === 'ar') return (extra?.[text] ?? labels[text])?.[language === 'nl' ? 0 : 1] ?? text;
  return packs.get(language)?.[text] || text;
}
