/**
 * The `/gorilla:plan` slash command, written into the project by `init`.
 *
 * Its instructions carry the goal-authoring rules and the guardrail taxonomy,
 * so the planning agent produces conditions the evaluator can actually assess
 * rather than aspirations. Getting that wrong is cheap to fix in the
 * conversation and expensive to discover on the board a day later.
 */

export const PLAN_COMMAND_NAME = 'plan.md';

export function planCommand(baseUrl: string, boardId?: string): string {
  const board = boardId ?? '<board-id>';
  const url = `${baseUrl.replace(/\/+$/, '')}/api/boards/${board}/plans`;

  return `---
description: Send this planning conversation's decomposition to the Gorilla board
---

Take the work we have just decomposed in this conversation and post it to the
Gorilla board as cards.

## Before posting, get the goal conditions right

Each card needs a goal condition, and the \`/goal\` evaluator has one property
that makes most conditions fail: **it does not run commands**. It sees only what
the agent surfaced in the conversation.

- Good: "every test in \`test/auth\` passes, verified by running \`npm test\` and
  showing its output, or stop after 20 turns"
- Bad: "the authentication module is cleanly refactored" - nothing can
  demonstrate that, so the goal runs until it hits its bound

So every condition needs: a **measurable end state**, a **stated check** whose
output will appear in the conversation, and a **turn bound**. Keep each under
4,000 characters.

## Guardrails carry an enforcement kind

Put constraints in the \`guardrails\` object. Know which are real:

- \`prohibit\` entries that name a **path** (\`src/db/schema.ts\`) or a **command
  pattern** (\`Bash(git push *)\`) become deny rules Claude Code enforces.
- \`prohibit\` entries phrased as advice ("do not over-engineer") are prompt text
  only. Prefer the expressible form where you can.
- \`scope\` is advisory. \`verify\` is a command the board runs itself.
- \`maxTurns\` is appended to the goal condition.

## Post it

\`\`\`bash
curl -sS -X POST ${url} \\
  -H 'content-type: application/json' \\
  -d '{
    "sourceSessionId": "<this session id>",
    "prompt": "<one line on what we were planning>",
    "cards": [
      {
        "title": "Short imperative title",
        "body": "What needs doing and why, in a few sentences.",
        "goalCondition": "<measurable end state>, verified by running \`<check>\`, or stop after 20 turns",
        "guardrails": {
          "scope": ["src/area/"],
          "prohibit": ["src/db/schema.ts"],
          "verify": "npm test",
          "maxTurns": 20
        },
        "agentModel": "sonnet",
        "dependsOn": ["Title of another card in this batch"]
      }
    ]
  }'
\`\`\`

## Then report back

The response contains \`warnings\` per card. **Read them out and offer to fix
them here**, in this conversation, while the context that produced the cards is
still loaded. Do not leave a warning for the operator to discover on the board.

Cards land unstarted, in the first column. Promotion to Ready and dispatch are
the operator's decision, not yours - say so, and stop.
`;
}
