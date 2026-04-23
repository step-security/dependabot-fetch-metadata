import * as core from '@actions/core'
import * as github from '@actions/github'
import { RequestError } from '@octokit/request-error'
import * as verifiedCommits from './dependabot/verified_commits'
import * as updateMetadata from './dependabot/update_metadata'
import * as output from './dependabot/output'
import * as util from './dependabot/util'
import axios, { isAxiosError } from 'axios';
import * as fs from 'fs'

async function validateSubscription(): Promise<void> {
  const eventPath = process.env.GITHUB_EVENT_PATH
  let repoPrivate: boolean | undefined

  if (eventPath && fs.existsSync(eventPath)) {
    const eventData = JSON.parse(fs.readFileSync(eventPath, 'utf8'))
    repoPrivate = eventData?.repository?.private
  }

  const upstream = 'dependabot/fetch-metadata'
  const action = process.env.GITHUB_ACTION_REPOSITORY
  const docsUrl =
    'https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions'

  core.info('')
  core.info('[1;36mStepSecurity Maintained Action[0m')
  core.info(`Secure drop-in replacement for ${upstream}`)
  if (repoPrivate === false)
    core.info('[32m✓ Free for public repositories[0m')
  core.info(`[36mLearn more:[0m ${docsUrl}`)
  core.info('')

  if (repoPrivate === false) return

  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com'
  const body: Record<string, string> = {action: action || ''}
  if (serverUrl !== 'https://github.com') body.ghes_server = serverUrl
  try {
    await axios.post(
      `https://agent.api.stepsecurity.io/v1/github/${process.env.GITHUB_REPOSITORY}/actions/maintained-actions-subscription`,
      body,
      {timeout: 3000}
    )
  } catch (error) {
    if (isAxiosError(error) && error.response?.status === 403) {
      core.error(
        `[1;31mThis action requires a StepSecurity subscription for private repositories.[0m`
      )
      core.error(
        `[31mLearn how to enable a subscription: ${docsUrl}[0m`
      )
      process.exit(1)
    }
    core.info('Timeout or API not reachable. Continuing to next step.')
  }
}

export async function run (): Promise<void> {
  await validateSubscription();
  const token = core.getInput('github-token')

  if (!token) {
     
    core.setFailed(
      'github-token is not set! Please add \'github-token: "${{ secrets.GITHUB_TOKEN }}"\' to your workflow file.'
    )
     
    return
  }

  try {
    const githubClient = github.getOctokit(token)

    // Validate the job
    const commitMessage = await verifiedCommits.getMessage(githubClient, github.context, core.getBooleanInput('skip-commit-verification'), core.getBooleanInput('skip-verification'))
    const branchNames = util.getBranchNames(github.context)
    const body = util.getBody(github.context)
    let alertLookup: updateMetadata.alertLookup | undefined
    if (core.getInput('alert-lookup')) {
      alertLookup = (name, version, directory) => verifiedCommits.getAlert(name, version, directory, githubClient, github.context)
    }
    const scoreLookup = core.getInput('compat-lookup') ? verifiedCommits.getCompatibility : undefined

    if (commitMessage) {
      // Parse metadata
      core.info('Parsing Dependabot metadata')

      const updatedDependencies = await updateMetadata.parse(commitMessage, body, branchNames.headName, branchNames.baseName, alertLookup, scoreLookup)

      if (updatedDependencies.length > 0) {
        output.set(updatedDependencies)
      } else {
        core.setFailed('PR does not contain metadata, nothing to do.')
      }
    } else {
      core.setFailed('PR is not from Dependabot, nothing to do.')
    }
  } catch (error) {
    if (error instanceof RequestError) {
      core.setFailed(`Api Error: (${error.status}) ${error.message}`)
      return
    }
    if (error instanceof Error) {
      core.setFailed(error.message)
    } else {
      core.setFailed('There was an unexpected error.')
    }
  }
}

run()
