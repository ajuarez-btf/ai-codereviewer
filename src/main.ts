import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/action";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");

const octokit = new Octokit({ auth: GITHUB_TOKEN });



const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error - response.data is a string
  return response.data;
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files
    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      const aiResponse = await getAIResponse(prompt);
      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }
  return comments;
}

async function getBaseAndHeadShas(
  owner: string,
  repo: string,
  pull_number: number
): Promise<{ baseSha: string; headSha: string }> {
  const prResponse = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
  });
  return {
    baseSha: prResponse.data.base.sha,
    headSha: prResponse.data.head.sha,
  };
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  return `Your task is to review pull requests. Instructions:
- Provide the response in following JSON format:  [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise return an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: NEVER suggest adding comments to the code.

Review the following code diff in the file "${
    file.to
  }" and take the pull request title and description into account when writing the response.
  
Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes
  // @ts-expect-error - ln and ln2 exists where needed
  .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
  .join("\n")}
\`\`\`
`;
}

async function getAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
}> | null> {
  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0.2,
    max_tokens: 700,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    console.log('Sending prompt to chatgpt');
    const response = await openai.chat.completions.create({
      ...queryConfig,
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
    });

    const res = response.choices[0].message?.content?.trim() || "[]";
    console.log('chat gpt response', res);
    return JSON.parse(res);
  } catch (error) {
    console.error("Error:", error);
    return null;
  }
}

function createComment(
  file: File,
  chunk: Chunk,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
  }>
): Array<{ body: string; path: string; line: number }> {
  return aiResponses.flatMap((aiResponse) => {
    if (!file.to) {
      return [];
    }
    return {
      body: aiResponse.reviewComment,
      path: file.to,
      line: Number(aiResponse.lineNumber),
    };
  });
}

async function sendComment(reviewParams: any, index: number) {
  return setTimeout(async () => {
      return octokit.pulls.createReview(reviewParams);
  }, 1000*index);
} 

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  // enviando los comentarios de 10 en 10 para evitar el limit_request
  const splitNumber = 20;

  for (let index = 0; index < Math.round(comments.length/splitNumber); index++) {
    let commentsToSent = comments.slice(index*splitNumber, (index+1)*splitNumber)
    if (commentsToSent.length) {
      console.log('comments to send', commentsToSent.length,commentsToSent);
      sendComment({
        owner,
        repo,
        pull_number,
        comments: commentsToSent,
        event: 'COMMENT'
      }, index);
    }
  }
  
}

async function main() {
  const prDetails = await getPRDetails();
  let diff: string | null;
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );
  console.log('Action', eventData.action);
  if (eventData.action === "opened") {
    diff = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );
  } else if (eventData.action === "synchronize") {
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;

    const response = await octokit.repos.compareCommits({
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha,
    });

    diff = String(response.data);
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  // const parsedDiff = parseDiff(diff);

  // const excludePatterns = core
  //   .getInput("exclude")
  //   .split(",")
  //   .map((s) => s.trim());

  // const filteredDiff = parsedDiff.filter((file) => {
  //   return !excludePatterns.some((pattern) =>
  //     minimatch(file.to ?? "", pattern)
  //   );
  // });

  // const comments = await analyzeCode(filteredDiff, prDetails);
  const comments = 
  [
    {
      body: "The name of the workflow should be more descriptive and meaningful. Consider changing it to something like 'AI Code Review Workflow'.",
      path: '.github/workflows/main.yml',
      line: 1
    },
    {
      body: "The 'pull_request' event type is already included by default, so there is no need to explicitly specify it.",
      path: '.github/workflows/main.yml',
      line: 4
    },
    {
      body: "The 'contents: read' permission is not necessary for this workflow. Please remove it.",
      path: '.github/workflows/main.yml',
      line: 8
    },
    {
      body: "The 'pull-requests: write' permission is not necessary for this workflow. Please remove it.",
      path: '.github/workflows/main.yml',
      line: 10
    },
    {
      body: "Consider giving the job a more descriptive name, such as 'AI Code Review Job'.",
      path: '.github/workflows/main.yml',
      line: 12
    },
    {
      body: 'The first echo statement is not necessary and can be removed.',
      path: '.github/workflows/main.yml',
      line: 15
    },
    {
      body: 'The second echo statement is not necessary and can be removed.',
      path: '.github/workflows/main.yml',
      line: 16
    },
    {
      body: 'The third echo statement is not necessary and can be removed.',
      path: '.github/workflows/main.yml',
      line: 17
    },
    {
      body: "Consider adding a more descriptive name to the 'Check out repository code' step, such as 'Checkout Repository Code'.",
      path: '.github/workflows/main.yml',
      line: 19
    },
    {
      body: 'The fourth echo statement is not necessary and can be removed.',
      path: '.github/workflows/main.yml',
      line: 21
    },
    {
      body: "Consider adding a more descriptive name to the 'List files in the repository' step, such as 'List Repository Files'.",
      path: '.github/workflows/main.yml',
      line: 23
    },
    {
      body: 'The fifth echo statement is not necessary and can be removed.',
      path: '.github/workflows/main.yml',
      line: 26
    },
    {
      body: "The 'ai-codereviewer' action should have a more descriptive name. Consider changing it to something like 'AI Code Review Action'.",
      path: '.github/workflows/main.yml',
      line: 27
    },
    {
      body: "The 'OPENAI_API_KEY' secret should be encrypted and stored in the repository settings. Please remove it from the workflow file.",
      path: '.github/workflows/main.yml',
      line: 29
    },
    {
      body: "The 'OPENAI_API_MODEL' input should have a more descriptive name. Consider changing it to something like 'AI Model Version'.",
      path: '.github/workflows/main.yml',
      line: 30
    },
    {
      body: "There is no need to exclude '*.txt' files from the AI Code Reviewer. Please remove it from the 'exclude' pattern.",
      path: '.github/workflows/main.yml',
      line: 32
    },
    {
      body: 'Consider removing the line `*.zip` from the .gitignore file. It is generally not recommended to include zip files in version control as they can be large and easily recreated if needed.',
      path: '.gitignore',
      line: 52
    },
    {
      body: 'Consider removing the line `infrastructure/.terraform/*` from the .gitignore file. It seems to be a duplicate entry as there is already a more specific entry for `events_integration/infra/.terraform/*`. Keeping only the more specific entry should be sufficient.',
      path: '.gitignore',
      line: 54
    },
    {
      body: 'The `terraform` block is missing a closing brace.',
      path: 'events_integration/infra/backend.tf',
      line: 1
    },
    {
      body: 'The `required_version` attribute is missing a value.',
      path: 'events_integration/infra/backend.tf',
      line: 2
    },
    {
      body: 'The `required_providers` block is missing a closing brace.',
      path: 'events_integration/infra/backend.tf',
      line: 5
    },
    {
      body: 'The `source` attribute is missing a value.',
      path: 'events_integration/infra/backend.tf',
      line: 6
    },
    {
      body: 'The `version` attribute is missing a value.',
      path: 'events_integration/infra/backend.tf',
      line: 7
    },
    {
      body: 'The `backend` block is missing a closing brace.',
      path: 'events_integration/infra/backend.tf',
      line: 11
    },
    {
      body: 'The `acl` attribute is missing a value.',
      path: 'events_integration/infra/backend.tf',
      line: 12
    },
    {
      body: 'The `region` attribute is missing a value.',
      path: 'events_integration/infra/backend.tf',
      line: 13
    },
    {
      body: 'The `encrypt` attribute is missing a value.',
      path: 'events_integration/infra/backend.tf',
      line: 14
    },
    {
      body: 'The `session_name` attribute is missing a value.',
      path: 'events_integration/infra/backend.tf',
      line: 15
    },
    {
      body: 'The variable `bucket` seems to be hardcoded. Consider using a variable or parameter to make it more flexible.',
      path: 'events_integration/infra/backends/prod.tfbackend',
      line: 1
    },
    {
      body: 'The variable `key` seems to be hardcoded. Consider using a variable or parameter to make it more flexible.',
      path: 'events_integration/infra/backends/prod.tfbackend',
      line: 2
    },
    {
      body: "The variable 'bucket' seems to be hardcoded. Consider using a variable or parameter to make it more flexible.",
      path: 'events_integration/infra/backends/stg.tfbackend',
      line: 1
    },
    {
      body: "The variable 'key' also seems to be hardcoded. Consider using a variable or parameter to make it more flexible.",
      path: 'events_integration/infra/backends/stg.tfbackend',
      line: 2
    },
    {
      body: "The pull request title is misspelled. It should be 'Feature/test' instead of 'Fature/test'.",
      path: 'events_integration/infra/main.tf',
      line: 1
    },
    {
      body: "The 'default_tags' block seems to be missing a closing bracket.",
      path: 'events_integration/infra/main.tf',
      line: 4
    },
    {
      body: "The 'source' attribute in module 'sqs' should have a relative path starting with './'.",
      path: 'events_integration/infra/main.tf',
      line: 25
    },
    {
      body: "The 'sqs_arn_gamification_level_start' attribute in module 'lambda' seems to be misspelled. It should be 'sqs_arn_gamification_level_start' instead of 'sqs_arn_gamification_level_start'.",
      path: 'events_integration/infra/main.tf',
      line: 39
    },
    {
      body: "The 'sqs_arn_gamification_node_redeemreward' attribute in module 'lambda' seems to be misspelled. It should be 'sqs_arn_gamification_node_redeemReward' instead of 'sqs_arn_gamification_node_redeemreward'.",
      path: 'events_integration/infra/main.tf',
      line: 43
    },
    {
      body: "The 'events_rol' attribute in module 'lambda' seems to be misspelled. It should be 'events_rol' instead of 'events_rol'.",
      path: 'events_integration/infra/main.tf',
      line: 44
    },
    {
      body: 'Consider providing a more descriptive name for the `aws_iam_role` data block.',
      path: 'events_integration/infra/modules/lambda/main.tf',
      line: 2
    },
    {
      body: "Check the spelling of the `var.events_rol` variable. It seems to be missing an 'e' at the end.",
      path: 'events_integration/infra/modules/lambda/main.tf',
      line: 3
    },
    {
      body: 'Consider providing a more descriptive name for the `archive_file` data block.',
      path: 'events_integration/infra/modules/lambda/main.tf',
      line: 7
    },
    {
      body: 'Consider using a more specific path for the `source_file` attribute in the `archive_file` data block.',
      path: 'events_integration/infra/modules/lambda/main.tf',
      line: 9
    },
    {
      body: 'Consider using a more specific output path for the `archive_file` data block.',
      path: 'events_integration/infra/modules/lambda/main.tf',
      line: 10
    },
    {
      body: 'Consider providing a more descriptive name for the `aws_lambda_function` resource block.',
      path: 'events_integration/infra/modules/lambda/main.tf',
      line: 14
    },
    {
      body: 'Consider providing a more descriptive name for the `function_name` attribute in the `aws_lambda_function` resource block.',
      path: 'events_integration/infra/modules/lambda/main.tf',
      line: 16
    },
    {
      body: 'Consider using a more specific default value for the `timeout` attribute in the `aws_lambda_function` resource block.',
      path: 'events_integration/infra/modules/lambda/main.tf',
      line: 18
    },
    {
      body: 'Consider using a more specific default value for the `memory_size` attribute in the `aws_lambda_function` resource block.',
      path: 'events_integration/infra/modules/lambda/main.tf',
      line: 19
    },
    {
      body: 'Consider using a more specific default value for the `runtime` attribute in the `aws_lambda_function` resource block.',
      path: 'events_integration/infra/modules/lambda/main.tf',
      line: 20
    },
    {
      body: 'Consider using a more specific value for the `filename` attribute in the `aws_lambda_function` resource block.',
      path: 'events_integration/infra/modules/lambda/main.tf',
      line: 21
    },
    {
      body: 'Consider using a more specific value for the `handler` attribute in the `aws_lambda_function` resource block.',
      path: 'events_integration/infra/modules/lambda/main.tf',
      line: 22
    },
    {
      body: 'Consider using a more specific value for the `description` attribute in the `aws_lambda_function` resource block.',
      path: 'events_integration/infra/modules/lambda/main.tf',
      line: 23
    },
    {
      body: 'Consider providing a more descriptive name for the `variables` attribute in the `environment` block.',
      path: 'events_integration/infra/modules/lambda/main.tf',
      line: 25
    },
    {
      body: 'Consider providing a more descriptive name for the `aws_lambda_event_source_mapping` resource block.',
      path: 'events_integration/infra/modules/lambda/main.tf',
      line: 30
    },
    {
      body: 'Consider providing a more descriptive name for the `event_source_arn` attribute in the `aws_lambda_event_source_mapping` resource block.',
      path: 'events_integration/infra/modules/lambda/main.tf',
      line: 31
    },
    {
      body: 'Consider providing a more descriptive name for the `function_name` attribute in the `aws_lambda_event_source_mapping` resource block.',
      path: 'events_integration/infra/modules/lambda/main.tf',
      line: 32
    },
    {
      body: "The variable name 'env_initial' is not descriptive. Please provide a more meaningful name.",
      path: 'events_integration/infra/modules/lambda/variables.tf',
      line: 1
    },
    {
      body: "The variable name 'events_rol' is not descriptive. Please provide a more meaningful name.",
      path: 'events_integration/infra/modules/lambda/variables.tf',
      line: 7
    },
    {
      body: "Consider providing a comment explaining why the 'nocheck' directive is used here.",
      path: 'events_integration/infra/modules/sqs/main.tf',
      line: 3
    },
    {
      body: "Consider providing a comment explaining the purpose of 'max_message_size'.",
      path: 'events_integration/infra/modules/sqs/main.tf',
      line: 8
    },
    {
      body: "Consider providing a comment explaining the purpose of 'data.aws_iam_policy_document.clients_policy[each.key].json'.",
      path: 'events_integration/infra/modules/sqs/main.tf',
      line: 19
    },
    {
      body: `Consider providing a comment explaining the purpose of 'lookup(each.value, "protocol", local.sqs_queues_default_values.protocol)'.`,
      path: 'events_integration/infra/modules/sqs/main.tf',
      line: 27
    },
    {
      body: "Consider using a more descriptive output name instead of 'sqs_arn_betteraction_done'.",
      path: 'events_integration/infra/modules/sqs/outputs.tf',
      line: 1
    },
    {
      body: 'Consider adding a comment explaining the purpose of this output.',
      path: 'events_integration/infra/modules/sqs/outputs.tf',
      line: 2
    },
    {
      body: "Consider using a more descriptive output name instead of 'sqs_arn_gamification_level_start'.",
      path: 'events_integration/infra/modules/sqs/outputs.tf',
      line: 5
    },
    {
      body: 'Consider adding a comment explaining the purpose of this output.',
      path: 'events_integration/infra/modules/sqs/outputs.tf',
      line: 6
    },
    {
      body: "Consider using a more descriptive output name instead of 'sqs_arn_gamification_level_finish'.",
      path: 'events_integration/infra/modules/sqs/outputs.tf',
      line: 9
    },
    {
      body: 'Consider adding a comment explaining the purpose of this output.',
      path: 'events_integration/infra/modules/sqs/outputs.tf',
      line: 10
    },
    {
      body: "Consider using a more descriptive output name instead of 'sqs_arn_gamification_node_statechange'.",
      path: 'events_integration/infra/modules/sqs/outputs.tf',
      line: 13
    },
    {
      body: 'Consider adding a comment explaining the purpose of this output.',
      path: 'events_integration/infra/modules/sqs/outputs.tf',
      line: 14
    },
    {
      body: "Consider using a more descriptive output name instead of 'sqs_arn_gamification_node_redeemreward'.",
      path: 'events_integration/infra/modules/sqs/outputs.tf',
      line: 17
    },
    {
      body: 'Consider adding a comment explaining the purpose of this output.',
      path: 'events_integration/infra/modules/sqs/outputs.tf',
      line: 18
    },
    {
      body: "The variable name 'env_initial' is not descriptive enough. Please provide a more meaningful name.",
      path: 'events_integration/infra/modules/sqs/variables.tf',
      line: 1
    },
    {
      body: "The variable name 'sns_arn_betteraction_done' is not descriptive enough. Please provide a more meaningful name.",
      path: 'events_integration/infra/modules/sqs/variables.tf',
      line: 2
    },
    {
      body: "The variable name 'sns_arn_gamification_level_start' is not descriptive enough. Please provide a more meaningful name.",
      path: 'events_integration/infra/modules/sqs/variables.tf',
      line: 3
    },
    {
      body: "The variable name 'sns_arn_gamification_level_finish' is not descriptive enough. Please provide a more meaningful name.",
      path: 'events_integration/infra/modules/sqs/variables.tf',
      line: 4
    },
    {
      body: "The variable name 'sns_arn_gamification_node_statechange' is not descriptive enough. Please provide a more meaningful name.",
      path: 'events_integration/infra/modules/sqs/variables.tf',
      line: 5
    },
    {
      body: "The variable name 'sns_arn_gamification_node_redeemReward' is not descriptive enough. Please provide a more meaningful name.",
      path: 'events_integration/infra/modules/sqs/variables.tf',
      line: 6
    },
    {
      body: "The variable name 'aws_account_id' is not descriptive enough. Please provide a more meaningful name.",
      path: 'events_integration/infra/modules/sqs/variables.tf',
      line: 7
    },
    {
      body: "The comment is missing a space after the '+' sign.",
      path: 'events_integration/infra/tfvars/prd.tfvars',
      line: 1
    },
    {
      body: "The comment is missing a space after the '+' sign.",
      path: 'events_integration/infra/tfvars/prd.tfvars',
      line: 2
    },
    {
      body: "The comment is missing a space after the '+' sign.",
      path: 'events_integration/infra/tfvars/prd.tfvars',
      line: 3
    },
    {
      body: "The comment is missing a space after the '+' sign.",
      path: 'events_integration/infra/tfvars/prd.tfvars',
      line: 4
    },
    {
      body: "The comment is missing a space after the '+' sign.",
      path: 'events_integration/infra/tfvars/prd.tfvars',
      line: 5
    },
    {
      body: "The comment is missing a space after the '+' sign.",
      path: 'events_integration/infra/tfvars/prd.tfvars',
      line: 6
    },
    {
      body: "The comment is missing a space after the '+' sign.",
      path: 'events_integration/infra/tfvars/prd.tfvars',
      line: 7
    },
    {
      body: "The comment is missing a space after the '+' sign.",
      path: 'events_integration/infra/tfvars/prd.tfvars',
      line: 8
    },
    {
      body: "The comment is missing a space after the '+' sign.",
      path: 'events_integration/infra/tfvars/prd.tfvars',
      line: 9
    },
    {
      body: "The comment is missing a space after the '+' sign.",
      path: 'events_integration/infra/tfvars/prd.tfvars',
      line: 10
    },
    {
      body: "The comment is missing a space after the '+' sign.",
      path: 'events_integration/infra/tfvars/prd.tfvars',
      line: 11
    },
    {
      body: 'The `environment` variable seems to be misspelled. It should be `environment` instead of `environemnt`.',
      path: 'events_integration/infra/tfvars/stg.tfvars',
      line: 1
    },
    {
      body: "Typo in pull request title: 'Fature/test' should be 'Feature/test'",
      path: 'events_integration/infra/variables.tf',
      line: 1
    },
    {
      body: 'Consider adding a module docstring to provide an overview of the purpose of this module.',
      path: 'events_integration/src/lambda/events_to_s3.py',
      line: 1
    },
    {
      body: "Consider using a more descriptive variable name instead of 's3_bucket_name'.",
      path: 'events_integration/src/lambda/events_to_s3.py',
      line: 8
    },
    {
      body: "Consider using a more descriptive variable name instead of 'events_path'.",
      path: 'events_integration/src/lambda/events_to_s3.py',
      line: 9
    },
    {
      body: "Consider adding a function docstring to describe the purpose of the 'lambda_handler' function.",
      path: 'events_integration/src/lambda/events_to_s3.py',
      line: 12
    },
    {
      body: 'Consider adding a comment to explain the purpose of the loop.',
      path: 'events_integration/src/lambda/events_to_s3.py',
      line: 15
    },
    {
      body: 'Consider adding a comment to explain the logic for generating the S3 object key.',
      path: 'events_integration/src/lambda/events_to_s3.py',
      line: 21
    },
    {
      body: "Consider adding a comment to explain the purpose of the 'put_object' method.",
      path: 'events_integration/src/lambda/events_to_s3.py',
      line: 25
    },
    {
      body: 'Consider adding a comment to explain the purpose of the return value.',
      path: 'events_integration/src/lambda/events_to_s3.py',
      line: 28
    }
  ];
  if (comments.length > 0) {
    await createReviewComment(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number,
      comments
    );
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
