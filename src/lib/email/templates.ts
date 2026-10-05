import 'server-only';
import type { Mail } from './send';

/**
 * The messages the school sends. Two languages, plain and legible, no images
 * to be blocked and no tracking pixels.
 *
 * Kept as one shared shell so every message from the institute looks like it
 * came from the same place. The copy lives here rather than in the next-intl
 * catalogues because it is server-only and never reaches the client bundle.
 */

interface Line {
  title: string;
  detail: string;
}

interface Shell {
  heading: string;
  intro: string;
  lines: Line[];
  outro: string;
}

const BRAND = '#128a68';
const INK = '#16221f';
const MUTED = '#5f736d';

function render(shell: Shell): string {
  const rows = shell.lines
    .map(
      (l) => `
      <tr>
        <td style="padding:10px 0;border-top:1px solid #e5ebe9">
          <div style="font-weight:600;color:${INK}">${l.title}</div>
          <div style="color:${MUTED};font-size:14px">${l.detail}</div>
        </td>
      </tr>`,
    )
    .join('');

  return `<!doctype html><html><body style="margin:0;background:#f2f7f6;padding:24px;font-family:system-ui,-apple-system,Segoe UI,sans-serif">
    <table role="presentation" width="100%" style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e5ebe9;border-radius:14px">
      <tr><td style="padding:28px 28px 8px">
        <div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:${BRAND};font-weight:600">Institut Talib Alim</div>
        <h1 style="margin:12px 0 0;font-size:22px;color:${INK}">${shell.heading}</h1>
        <p style="color:${MUTED};line-height:1.6">${shell.intro}</p>
      </td></tr>
      <tr><td style="padding:0 28px">
        <table role="presentation" width="100%">${rows}</table>
      </td></tr>
      <tr><td style="padding:16px 28px 28px">
        <p style="color:${MUTED};font-size:14px;line-height:1.6">${shell.outro}</p>
      </td></tr>
    </table>
  </body></html>`;
}

function plain(shell: Shell): string {
  const lines = shell.lines.map((l) => `- ${l.title}: ${l.detail}`).join('\n');
  return `${shell.heading}\n\n${shell.intro}\n\n${lines}\n\n${shell.outro}\n\n— Institut Talib Alim`;
}

export interface OrderConfirmationData {
  to: string;
  locale: 'fr' | 'en';
  orderRef: string;
  items: { title: string; scheduleLabel: string; untilLabel: string }[];
  totalLabel: string;
}

export function orderConfirmation(data: OrderConfirmationData): Mail {
  const fr = data.locale === 'fr';
  const shell: Shell = {
    heading: fr ? 'Votre inscription est confirmée' : 'Your enrolment is confirmed',
    intro: fr
      ? 'Merci. Votre accès est ouvert ; vous le retrouvez à tout moment dans votre espace.'
      : 'Thank you. Your access is open; you can find it any time in your space.',
    lines: [
      ...data.items.map((i) => ({
        title: i.title + (i.scheduleLabel ? ` — ${i.scheduleLabel}` : ''),
        detail: fr ? `Accès jusqu’au ${i.untilLabel}` : `Access until ${i.untilLabel}`,
      })),
      {
        title: fr ? 'Total réglé' : 'Total paid',
        detail: data.totalLabel,
      },
    ],
    outro: fr
      ? `Commande n° ${data.orderRef}. Conservez cet e-mail comme justificatif. Pour toute question, répondez-y simplement.`
      : `Order no. ${data.orderRef}. Keep this email as your record. For any question, just reply to it.`,
  };
  return {
    to: data.to,
    subject: fr
      ? 'Inscription confirmée — Institut Talib Alim'
      : 'Enrolment confirmed — Institut Talib Alim',
    html: render(shell),
    text: plain(shell),
  };
}

export interface NewRegistrationData {
  to: string;
  fullName: string;
  email: string;
  reviewUrl: string;
}

/**
 * What the office is told when somebody registers.
 *
 * Always in French: this one goes to the school, not to a student, and the
 * school reads French. It carries the link to the person's page so the office
 * is one tap from seeing who registered rather than hunting through a list.
 */
export interface StudentApprovedData {
  to: string;
  fullName: string;
  locale: string;
  spaceUrl: string;
}

/**
 * The student's account was let in — the only e-mail a student gets.
 *
 * Sent the moment an admin approves, and it is both the approval and the
 * welcome: the account is validated, so it is also the first time the school
 * has something true to say about the space. Nothing is sent at sign-up, when
 * the account cannot yet open an order; the mailbox stays quiet until the
 * office has actually decided.
 */
export function studentApproved(data: StudentApprovedData): Mail {
  const fr = data.locale === 'fr';
  const name = data.fullName.trim();
  const shell: Shell = {
    heading: fr ? 'Bienvenue à l’Institut Talib Alim' : 'Welcome to Institut Talib Alim',
    intro: fr
      ? `${name ? `${name}, v` : 'V'}otre inscription est validée et votre compte est ouvert. Vous pouvez dès maintenant parcourir les modules, choisir ceux qui vous intéressent et suivre vos cours depuis votre espace.`
      : `${name ? `${name}, y` : 'Y'}our registration is approved and your account is open. You can now browse the modules, choose the ones you want and follow your classes from your own space.`,
    lines: [{ title: fr ? 'Votre espace' : 'Your space', detail: data.spaceUrl }],
    outro: fr
      ? 'Une question sur un module ou un cursus ? Répondez simplement à cet e-mail, nous vous répondrons.'
      : 'A question about a module or a programme? Just reply to this email and we will answer.',
  };
  return {
    to: data.to,
    subject: fr
      ? 'Votre inscription est validée — bienvenue à l’Institut Talib Alim'
      : 'Your registration is approved — welcome to Institut Talib Alim',
    html: render(shell),
    text: plain(shell),
  };
}

export interface SecurityAlertData {
  to: string;
  /** What happened, in French: this goes to the school. */
  action: string;
  actor: string;
  detail: string;
  /** The one-click "it was not me", when the change can be undone. */
  revertUrl: string | null;
}

/**
 * Something sensitive was changed.
 *
 * Always in French, always to the office mailbox. The point is not the
 * notification — it is the LINK: one click closes the money path and starts
 * the password reset, without waiting for anyone to be at a computer.
 */
export function securityAlert(data: SecurityAlertData): Mail {
  const shell: Shell = {
    heading: data.action,
    intro: `Ce changement a été fait depuis le compte ${data.actor}. Si c’est bien vous, ignorez ce message.`,
    lines: [
      { title: 'Détail', detail: data.detail },
      ...(data.revertUrl
        ? [{ title: 'Ce n’était pas moi', detail: data.revertUrl }]
        : []),
    ],
    outro: data.revertUrl
      ? 'Le lien ci-dessus coupe immédiatement le paiement en ligne et vide les identifiants enregistrés, puis vous recevrez un e-mail pour changer votre mot de passe. Vous pourrez ensuite remettre les identifiants.'
      : 'Sans clé STEPUP_SECRET configurée, ce lien ne peut pas être généré : changez le mot de passe du compte administrateur dès maintenant.',
  };
  return {
    to: data.to,
    subject: `Sécurité — ${data.action}`,
    html: render(shell),
    text: plain(shell),
  };
}

export interface PaymentDueData {
  to: string;
  fullName: string;
  locale: string;
  /** Already formatted for the reader, by the caller that knows the locale. */
  amount: string;
  due: string;
  spaceUrl: string;
  /** True on the day itself and after: the door is closed until it is paid. */
  overdue: boolean;
}

/**
 * An installment is due, or has been missed.
 *
 * Sent by the sweep a week before, the day before, and on the day. It names
 * the amount and the date, and links straight to the space where it can be
 * paid — the message is useless if finding the button takes five minutes.
 */
export function paymentDue(data: PaymentDueData): Mail {
  const fr = data.locale === 'fr';
  const name = data.fullName.trim();
  const shell: Shell = {
    heading: data.overdue
      ? fr
        ? 'Échéance à régler'
        : 'Installment to settle'
      : fr
        ? 'Votre prochaine échéance'
        : 'Your next installment',
    intro: data.overdue
      ? fr
        ? `${name ? `${name}, l` : 'L'}’échéance de ${data.amount} était due le ${data.due}. L’accès aux cours est suspendu jusqu’au règlement.`
        : `${name ? `${name}, t` : 'T'}he ${data.amount} installment was due on ${data.due}. Access to the courses is suspended until it is settled.`
      : fr
        ? `${name ? `${name}, v` : 'V'}otre prochaine échéance de ${data.amount} arrive le ${data.due}.`
        : `${name ? `${name}, y` : 'Y'}our next installment of ${data.amount} is due on ${data.due}.`,
    lines: [
      { title: fr ? 'Montant' : 'Amount', detail: data.amount },
      { title: fr ? 'Échéance' : 'Due date', detail: data.due },
      { title: fr ? 'Payer depuis votre espace' : 'Pay from your space', detail: data.spaceUrl },
    ],
    outro: fr
      ? 'Vous pouvez aussi régler en espèces à l’institut : un code remis à l’accueil règle l’échéance.'
      : 'You can also pay in cash at the institute: a code from the desk settles the installment.',
  };
  return {
    to: data.to,
    subject: data.overdue
      ? fr
        ? `Échéance à régler : ${data.amount}`
        : `Installment to settle: ${data.amount}`
      : fr
        ? `Prochaine échéance : ${data.amount}`
        : `Next installment: ${data.amount}`,
    html: render(shell),
    text: plain(shell),
  };
}

export interface OfficeApprovalData {
  to: string;
  fullName: string;
  email: string;
  approved: boolean;
}

/**
 * What the office is told once it has decided.
 *
 * A copy for the record: the admin who clicked knows what they clicked, but
 * the mailbox is shared and a second person reading it later should be able to
 * see that an account was let in — and which one.
 */
export function officeApprovalNotice(data: OfficeApprovalData): Mail {
  const shell: Shell = {
    heading: data.approved ? 'Compte validé' : 'Compte remis en attente',
    intro: data.approved
      ? 'L’étudiant peut désormais s’inscrire à un module ou à un cursus.'
      : 'L’étudiant ne peut plus ouvrir de commande tant que le compte n’est pas validé.',
    lines: [
      { title: data.fullName || '—', detail: data.email },
      {
        title: 'Décision',
        detail: data.approved ? 'Validé' : 'Remis en attente',
      },
    ],
    outro: 'Vous pouvez modifier cette décision depuis Administration → Étudiants.',
  };
  return {
    to: data.to,
    subject: data.approved
      ? `Compte validé : ${data.fullName || data.email}`
      : `Compte remis en attente : ${data.fullName || data.email}`,
    html: render(shell),
    text: plain(shell),
  };
}

export function newRegistration(data: NewRegistrationData): Mail {
  const shell: Shell = {
    heading: 'Nouvelle inscription à valider',
    intro:
      'Quelqu’un vient de créer un compte. Il reste en attente tant que vous ne l’avez pas validé.',
    lines: [
      { title: data.fullName || '—', detail: data.email },
      { title: 'Ouvrir la fiche', detail: data.reviewUrl },
    ],
    outro: 'Vous pouvez aussi valider depuis Administration → Étudiants.',
  };
  return {
    to: data.to,
    subject: `Nouvelle inscription : ${data.fullName || data.email}`,
    html: render(shell),
    text: plain(shell),
  };
}
