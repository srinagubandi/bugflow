import { Resend } from 'resend';

type EmailInput = {
  to: string;
  subject: string;
  html: string;
  fromName?: string | null;
  replyTo?: string | null;
};

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

function sender(fromName?: string | null) {
  const configured = process.env.RESEND_FROM_EMAIL;
  if (!configured) return null;
  return fromName ? `${fromName} <${configured}>` : configured;
}

export async function sendBugFlowEmail(input: EmailInput) {
  const from = sender(input.fromName);
  if (!resend || !from) {
    return { sent: false, reason: 'Email delivery is not configured.' } as const;
  }

  const response = await resend.emails.send({
    from,
    to: input.to,
    subject: input.subject,
    html: input.html,
    replyTo: input.replyTo ?? undefined,
  });

  if (response.error) {
    throw new Error(response.error.message);
  }
  return { sent: true, id: response.data?.id ?? null } as const;
}

export function reportUpdateEmail(input: {
  organizationName: string;
  reportId: string;
  reportTitle: string;
  update: string;
  url: string;
}) {
  const escapedUpdate = input.update.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
  const escapedTitle = input.reportTitle.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
  return `<div style="font-family:Inter,Arial,sans-serif;color:#222;line-height:1.5"><p style="color:#6b61dd;font-weight:700;margin:0 0 18px">BugFlow</p><h2 style="margin:0 0 8px">Update on ${input.reportId}</h2><p style="margin:0 0 18px">${escapedTitle}</p><div style="padding:16px;border-left:3px solid #756be8;background:#f5f4ff">${escapedUpdate}</div><p style="margin-top:22px"><a href="${input.url}" style="color:#6257dc">View report in BugFlow</a></p><p style="color:#777;font-size:12px">Sent by ${input.organizationName} through BugFlow.</p></div>`;
}
