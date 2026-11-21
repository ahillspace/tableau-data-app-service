# GitHub repository explorer

This Data App restores a Tableau session, lists the repositories available to the connected GitHub token, and browses branches, commits, and pull requests.
Pull request details show check runs and commit statuses for the head SHA, with separate results and errors for each.
The viewer can approve, request changes, close a pull request, or perform a direct merge.

## Set up the connection

1. As an operator, create a definition from the **GitHub.com** catalog template in the console and add the trusted Tableau sites that should see it.
   Use the ID `github`, or set `GITHUB_DEFINITION` below to match the ID you choose.
   The template uses a personal static token, sent as an `Authorization: Bearer` header only to `https://api.github.com`.
2. In GitHub, create a [fine-grained personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token) for the resource owner and repositories you want to browse.
   Grant the read permissions below and add write permissions only for actions you want the token to perform.
   Repository access, organization token approval, and branch rules still apply.
3. Open the example, sign in with Tableau, and save the token in the GitHub token field.
   The app clears the field on submission and the service seals the token in the viewer's personal connection.
   Replace an expired token through the same field, or remove the stored credential with **Disconnect GitHub**.

For CLI setup without the console, copy the `definition` object from [the catalog template](../../src/catalog/templates/github.json) into a JSON file, add `"id": "github"`, and fill `audience` with trusted site record IDs from `tdas sites list`.
Run `tdas definitions create PATH` on that file.
See [Connections](../../docs/connections.md) for operator and definition setup.

## REST endpoints and permissions

Paths below use `/repos/{owner}/{repo}` where shown as `/repos/…`.
Each operation goes through the SDK's native `fetch` with GitHub's REST media type and API version `2026-03-10`.

| Action                           | GitHub endpoint                                                                                                                                                                         | Repository permission                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Browse repositories              | [`GET /user/repos`](https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user)                                                                           | Metadata, read                       |
| Browse branches and commits      | [`GET /repos/…/branches`](https://docs.github.com/en/rest/branches/branches#list-branches), [`GET /repos/…/commits`](https://docs.github.com/en/rest/commits/commits#list-commits)      | Contents, read                       |
| Browse and inspect pull requests | [`GET /repos/…/pulls`](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests), [`GET /repos/…/pulls/{number}`](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request) | Pull requests, read                  |
| View check runs                  | [`GET /repos/…/commits/{sha}/check-runs`](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference)                                                              | Checks, read, with a supported token |
| View commit statuses             | [`GET /repos/…/commits/{sha}/statuses`](https://docs.github.com/en/rest/commits/statuses#list-commit-statuses-for-a-reference)                                                          | Commit statuses, read                |
| Approve or request changes       | [`POST /repos/…/pulls/{number}/reviews`](https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request)                                                              | Pull requests, write                 |
| Close                            | [`PATCH /repos/…/pulls/{number}`](https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request)                                                                                    | Pull requests, write                 |
| Direct merge                     | [`PUT /repos/…/pulls/{number}/merge`](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)                                                                                 | Contents, write                      |

GitHub documents private check runs for GitHub App tokens and for classic PATs with `repo` scope.
To view private check runs with fine-grained repository permissions, paste a GitHub App user access token issued outside this example and grant that app the listed repository permissions including **Checks: read**.
The example displays the Checks API response independently of commit statuses, so a token's inability to read check runs is visible.

Requesting changes submits a review with a required comment and keeps the pull request open.
Closing changes the pull request state to `closed`.
Merging sends the displayed head SHA to guard against concurrent pushes and displays GitHub's response.
This example uses direct merges, so use GitHub for repositories that require a merge queue or for stacked pull requests.

## Run it

Start the service and run `node examples/github/dev.ts` from the repository root.
The dev server builds the app and serves it on loopback.

| Variable            | Default                 |
| ------------------- | ----------------------- |
| `SERVICE_ORIGIN`    | `http://127.0.0.1:3000` |
| `APP_ID`            | `github-example`        |
| `GITHUB_DEFINITION` | `github`                |
| `EXAMPLE_PORT`      | `3101`                  |

For a Data App bundle, include `index.html`, `style.css`, and the `app.js` built from `app.ts`.
For example, use esbuild from the repository root, substituting the service's public HTTPS origin and the definition ID you configured.

```sh
npx esbuild examples/github/app.ts --bundle --format=esm --platform=browser \
  --target=es2024 --outfile=/tmp/github-data-app/app.js \
  --define:EXAMPLE_CONFIGURATION='{"serviceOrigin":"https://service.example","appId":"github-example","definitionId":"github"}'
cp examples/github/index.html examples/github/style.css /tmp/github-data-app/
```
