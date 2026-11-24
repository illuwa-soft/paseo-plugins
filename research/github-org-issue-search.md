# GitHub 조직 이슈 조회: 상한, 페이지네이션, 부분 실패

- 작성일: 2026-11-25
- 티켓: illuwa-soft/paseo-plugins#2 (map: #1)
- 측정 환경: `gh version 2.97.0 (2026-07-31)`, 인증 계정 `yontani`(illuwa-soft admin), 토큰 scope `admin:org_hook, gist, read:org, repo, workflow`(응답 헤더 `X-Oauth-Scopes` 기준)
- 측정은 모두 읽기 전용(GraphQL query, REST GET)이다.
- 측정 시점의 illuwa-soft 수치: 저장소 89개, 열린 이슈 91건(그중 비공개 저장소 82건, 이슈가 있는 저장소 19개), 전체 이슈 522건. 티켓 작성 때 적은 83/510보다 늘어 있다.

## 요약

| # | 질문 | 답 |
|---|------|----|
| 1 | 1,000건 상한 | 스키마에 "returning a maximum of 1,000 results"라고 적혀 있다. 1,000번째 결과를 넘기면 `hasNextPage: false`, `nodes: []`가 오고, 이때도 `issueCount`는 실제 매칭 수(예: 156,063)를 그대로 돌려준다. 오류는 나지 않는다. |
| 2 | 커서 페이지네이션 | `first` 값은 1~100이고, 101을 넣으면 `EXCESSIVE_PAGINATION` 오류가 난다. 커서는 `base64("cursor:N")` 형태의 오프셋이다. 페이지를 넘기는 사이에 데이터가 바뀌면 같은 항목이 두 번 나오거나 빠질 수 있다. 문서에는 정렬 안정성에 대한 언급이 없다. |
| 3 | `issueCount` 정확도 | 문서에는 정확하다는 보장도, 근사치라는 언급도 없다. 측정에서는 per-repo `issues.totalCount` 합계(91)와 같았다. REST에는 `incomplete_results`(타임아웃 신호)가 있지만 GraphQL `search`에는 그 필드가 없다. |
| 4 | Rate limit 비용 | GraphQL `search(first:100)` 한 번에 1 point가 든다. 중첩 연결을 넣어도 2~3 point였다. REST search 버킷(30회/분)은 소모되지 않았다. |
| 5 | `data`+`errors` 동시 응답 | `gh api graphql`은 **exit 1**로 끝난다. stdout에는 응답 본문 전체가 그대로 나오고 `--jq`는 적용되지 않는다. stderr에는 `gh: <각 error message를 줄바꿈으로 이은 문자열>`이 나온다. |
| 6 | SSO, 권한 부족, 비공개 저장소 | 접근할 수 없는 저장소는 결과에서 소리 없이 빠진다. GraphQL `search`는 존재하지 않거나 볼 수 없는 `org:`/`repo:`에 대해서도 **exit 0, `issueCount: 0`**을 돌려준다(REST는 422). SSO 미인가 조직은 결과가 빠지고 `X-GitHub-SSO: partial-results; organizations=...` 헤더로만 알려진다. |
| 7 | 저장소별 조회 | `organization.repositories(first:100){ issues(states:OPEN, first:100) }`는 1 point, `labels(first:20)`과 `closedByPullRequestsReferences(first:5)`까지 중첩하면 201 point였다. 같은 필드를 search로 가져오면 2 point였다. |
| 8 | `closedByPullRequestsReferences` | 기본값(`includeClosedPrs:false`)에서도 OPEN과 MERGED PR이 함께 나온다. 이 필드는 closing reference(기본 브랜치를 향한 키워드 또는 수동 연결)만 담는다. 저장소를 넘나드는 연결이 가능하다는 것은 문서로만 확인했고, 측정 표본에는 없었다. |

## 1. `search` 결과 1,000건 상한

**문서(1차 출처: GraphQL 스키마 introspection, 2026-11-25)**

- `Query.search`: "Perform a search across resources, returning a maximum of 1,000 results."
- `SearchResultItemConnection.issueCount`: "The total number of issues that matched the search query. Regardless of the total number of matches, a maximum of 1,000 results will be available across all types."
- REST 문서(https://docs.github.com/en/rest/search/search)에도 같은 상한("up to 1,000 results for each search")이 있다.

**측정**: 공개 조직 `org:microsoft is:issue state:open`에 직접 만든 커서를 넣어 봤다.

```
gh api graphql -f query='query($q:String!,$after:String){ rateLimit{cost remaining} s:search(query:$q,type:ISSUE,first:100,after:$after){ issueCount pageInfo{hasNextPage endCursor} nodes{ ... on Issue{ number } } } }' -f q='org:microsoft is:issue state:open' -f after="$(printf 'cursor:900'|base64)"
```

| after | issueCount | nodes | hasNextPage | endCursor |
|-------|-----------|-------|-------------|-----------|
| (없음) | 156063 | 100 | true | `cursor:100` |
| `cursor:900` | 156063 | 100 | **false** | `cursor:1000` |
| `cursor:1000` | 156063 | 0 | false | null |
| `cursor:1500` | 156063 | 0 | false | null |

- 1,000번째 결과에서 `hasNextPage`가 `false`로 바뀐다. 결과가 정말 끝났을 때와 상한에 걸렸을 때 `hasNextPage` 값이 똑같다. 그래서 `hasNextPage`만 보고는 결과를 다 받았는지 알 수 없다. 받은 노드 수를 `issueCount`와 비교해야 한다.
- 상한에 걸려도 오류가 나지 않는다. REST는 다르다. `search/issues?...&per_page=100&page=11`을 요청하면 `{"message":"Only the first 1000 search results are available","status":"422"}`가 오고 gh는 exit 1로 끝난다.

## 2. 커서 페이지네이션과 정렬 안정성

**문서**

- "The value of these arguments must be between 1 and 100." (https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api)
- "Clients must supply a `first` or `last` argument on any connection." / "Values of `first` and `last` must be within 1-100." (https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)
- 두 문서 모두 페이지를 넘기는 사이 데이터가 바뀔 때 순서가 유지되는지는 다루지 않는다. 정렬 문서(https://docs.github.com/en/search-github/getting-started-with-searching-on-github/sorting-search-results)도 `sort:updated`가 "sorts by how recently the items were updated"라고만 적고, 동점 처리나 안정성은 말하지 않는다.

**측정**

- `first:101`을 넣으면 exit 1이 나고 `{"errors":[{"type":"EXCESSIVE_PAGINATION",...,"message":"Requesting 101 records on the `search` connection exceeds the `first` limit of 100 records."}]}`가 온다.
- `endCursor` 값 `Y3Vyc29yOjEwMA==`를 디코드하면 `cursor:100`이다. 커서가 결과 집합 안에서의 **오프셋**이라는 뜻이다(관찰한 사실이며 문서화된 계약은 아니다). 정렬 기준이 `sort:updated-desc`이므로 페이지 사이에 어떤 이슈가 갱신되면 그 이슈가 맨 앞으로 옮겨진다. 그러면 뒤 페이지에서 한 칸씩 밀려 같은 항목이 다시 나오고, 이미 지나간 앞쪽 위치로 올라간 항목은 이번 조회에서 빠진다.
- 데이터가 바뀌지 않는 동안에는 순서가 안정적이었다. 열린 이슈 91건을 `first:30`으로 4페이지에 나눠 받은 결과와 `first:100` 한 번에 받은 결과의 id 순서가 같았다(`SAME_ORDER`, 중복 0).
- `org:illuwa-soft is:issue sort:updated-desc` 전체 522건을 100건씩 6페이지로 받았다. 페이지마다 `issueCount` 522, cost 1이었고 마지막 페이지는 22건에 `hasNextPage:false`였다.

## 3. `issueCount` 정확도와 `incomplete_results`

- GraphQL 스키마 설명은 "The total number of issues that matched the search query"뿐이다. 정확한 값이라는 보장도, 근사치라는 언급도 없다.
- REST 문서: 쿼리가 오래 걸려 타임아웃되면 "`incomplete_results` property set to `true`"가 되고, "Reaching a timeout does not necessarily mean that search results are incomplete."라고 적혀 있다. GraphQL `SearchResultItemConnection`에는 이 필드가 없다. introspection으로 확인한 필드는 `codeCount, discussionCount, edges, issueCount, issueSearchType, lexicalFallbackReason, nodes, pageInfo, repositoryCount, userCount, wikiCount`다.
- 측정
  - search `issueCount`는 91이었다. 저장소별로 센 `organization.repositories.nodes[].issues(states:OPEN).totalCount`의 합도 91이어서 서로 일치했다.
  - REST `search/issues?q=org:illuwa-soft+is:issue+state:open+archived:false`는 `{"incomplete_results":false,"total_count":91}`였다.
- 참고: 스키마에는 `issueSearchType`(LEXICAL/SEMANTIC/HYBRID)과 `SearchType`의 `ISSUE_ADVANCED`, `ISSUE_SEMANTIC`, `ISSUE_HYBRID`가 있다. `type: ISSUE`로 조회했을 때 측정된 `issueSearchType`은 `LEXICAL`이었다.

## 4. Rate limit 비용

**문서** (https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)

- 사용자 기준 1차 한도는 "5,000 points per hour per user"다.
- 비용 계산: 모든 연결이 `first`/`last` 한도까지 찬다고 가정해 필요한 요청 수를 더한 뒤 "Divide the number by 100 and round the result to the nearest whole number"하고, 최소 1 point다.
- 2차 한도: "No more than 100 concurrent requests", "No more than 2,000 points per minute are allowed for the GraphQL API endpoint."
- 노드 한도: "Individual calls cannot request more than 500,000 total nodes."
- 이 문서는 search 전용 한도를 따로 다루지 않는다. REST search는 인증 시 "30 requests per minute"다(https://docs.github.com/en/rest/search/search).

**측정**

| 쿼리 | `rateLimit.cost` |
|------|------------------|
| `search(first:100){ issueCount pageInfo nodes{...Issue{number repository{...}}} }` | 1 |
| 위 쿼리에 `labels(first:20)`, `closedByPullRequestsReferences(first:5)` 중첩 | 2 |
| 위 쿼리에 `closedByPullRequestsReferences` 별칭 3개(first:10) 중첩 | 3 |

- 전후 비교: GraphQL search를 3번 호출하는 동안 `gh api rate_limit`의 `resources.graphql.used`는 37에서 40으로 늘었고, `resources.search.used`는 0 그대로였다. REST search를 2번 호출하자 `search.used`가 2로 늘었다. GraphQL search는 REST search 버킷(30/분)이 아니라 GraphQL point 버킷에서 차감된다.
- 관찰: 연속 호출 사이에 `rateLimit.remaining` 값이 4781에서 4968로 늘었다가 다시 줄어드는 식으로 오락가락했다. 백엔드마다 카운터가 다른 것으로 보이며, 이 값을 엄밀한 예산 계산에 쓰기는 어렵다.

## 5. `gh api graphql`이 `data`와 `errors`를 함께 받을 때

**측정 1**: 정상 search와 존재하지 않는 node 조회를 별칭으로 묶어 보냈다.

```
gh api graphql -f query='{ ok:search(query:"org:illuwa-soft is:issue state:open",type:ISSUE,first:1){issueCount} bad:node(id:"MDU6SXNzdWUxMjM0NTY3ODk5OTk5OTk="){id} }'
```

- exit: `1`
- stdout: `{"data":{"ok":{"issueCount":91},"bad":null},"errors":[{"type":"NOT_FOUND","path":["bad"],...,"message":"Could not resolve to a node with the global id of '...'."}]}`
- stderr: `gh: Could not resolve to a node with the global id of '...'.`

**측정 2**: 같은 형태로 `bad:repository(owner:"illuwa-soft",name:"does-not-exist-zz")`를 넣고 `--jq '.data'`를 붙였다.

- exit `1`. stdout에는 `.data`만이 아니라 **본문 전체**가 나왔다. 오류가 있으면 jq 필터가 적용되지 않는다.

**측정 3**: 오류가 두 개(`a:node(id:"bad1")`, `b:node(id:"bad2")`)인 경우 stderr는 `gh: Could not resolve ... 'bad1'` 다음 줄에 `Could not resolve ... 'bad2'`였다.

**원인(gh v2.97.0 소스 `pkg/cmd/api/api.go`)**

- `processResponse`는 요청 경로가 `graphql`이면 HTTP 200이어도 `parseErrorResponse`를 부른다. `errors` 배열이 비어 있지 않으면 각 `message`를 `"\n"`으로 이어 `serverError`를 만든다.
- `serverError != ""`이면 `--jq`/`--template`을 건너뛰고 본문을 그대로 stdout에 쓴다. 그다음 `gh: %s`를 stderr에 쓰고 `cmdutil.SilentError`(exit 1)를 반환한다.
- 같은 위치에서 `factory.SSOURL()`이 있으면 `Authorize in your web browser: <url>`도 stderr에 덧붙인다.
- 소스: https://github.com/cli/cli/blob/v2.97.0/pkg/cmd/api/api.go

**현재 코드와의 관계**: `github-board/server/board.ts`의 `gh()`는 `execFileAsync`가 실패하면 stdout을 버리고 `describeGhFailure`로 stderr만 메시지로 만든다. 그래서 부분 성공한 `data`도 함께 사라진다. 같은 파일의 주석(CHECKS_QUERY 위)에도 "`gh api graphql` treats any GraphQL error as a failed command"라고 적혀 있다. 부분 결과를 살리려면 non-zero exit일 때 `error.stdout`을 JSON으로 파싱해 `data`와 `errors[].path`를 읽어야 한다. 이는 사실 관계에서 나온 함의다.

## 6. SSO, 권한 부족, 비공개 저장소

**문서**

- REST search: "the response will only contain the resources that you have access to" 그리고 접근할 수 없는 `repo:`/`user:`/`org:`를 지정하면 "Validation Failed" 오류가 날 수 있다(https://docs.github.com/en/rest/search/search).
- 검색 문법 문서의 `archived:false` 예시: "unarchived repositories you have access to"(https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests).
- SAML SSO(https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api)
  - classic PAT는 "you will need to authorize your token after creation."
  - 단일 조직이면 "you may receive a `404 Not Found` or a `403 Forbidden` error", 그리고 403이면 `X-GitHub-SSO` 헤더에 인가 URL이 담긴다.
  - 여러 조직에 걸친 요청이면 "the API will not return results from the organizations that require SAML SSO"이고, 헤더는 `X-GitHub-SSO: partial-results; organizations=21955855,20582480` 형식이다.
  - fine-grained PAT는 생성 시점에 인가된다.

**측정**

| 쿼리 | 결과 |
|------|------|
| GraphQL `search(query:"repo:illuwa-soft/does-not-exist-zz is:issue")` | exit 0, `{"data":{"search":{"issueCount":0}}}` |
| GraphQL `search(query:"org:nonexistent-org-zz-12345 is:issue")` | exit 0, `{"data":{"search":{"issueCount":0}}}` |
| REST `search/issues?q=repo:illuwa-soft/does-not-exist-zz+is:issue` | HTTP 422 `Validation Failed`, "The listed users and repositories cannot be searched either because the resources do not exist or you do not have permission to view them." |
| `gh api -i graphql` (illuwa-soft search) | 응답 헤더에 `X-GitHub-SSO` 없음. illuwa-soft에서 SSO 영향이 없거나 SSO를 강제하지 않는 것으로 보인다. |

- GraphQL search는 조직 이름 오타, 권한 상실, 접근할 수 없는 조직을 구분하지 못하고 모두 "0건"으로 돌려준다. REST와 달리 오류가 나지 않는다.
- 현재 토큰(admin, `repo` scope)으로는 비공개 저장소의 이슈 82건이 search 결과에 포함됐다. 비공개 저장소 접근이 없는 토큰이라면 해당 이슈가 결과와 `issueCount` 양쪽에서 함께 빠질 것이다. 문서상 "only contain the resources that you have access to"이기 때문인데, 권한이 없는 토큰으로 직접 측정하지는 않았다.
- SSO 미인가로 결과가 빠졌을 때 GraphQL 응답에도 `X-GitHub-SSO: partial-results`가 붙는지는 측정하지 않았다(SSO 강제 조직이 없어서다). gh는 헤더만 확인할 수 있고 본문은 정상이므로, 이 경우 exit 0으로 일부 결과만 돌아올 가능성이 있다. 미확인 사항이다.

## 7. 저장소별 조회 방식의 비용과 형태

```
gh api graphql -f query='{ rateLimit{cost remaining} organization(login:"illuwa-soft"){ repositories(first:100){ totalCount pageInfo{hasNextPage} nodes{ nameWithOwner isArchived issues(states:OPEN,first:100){ totalCount pageInfo{hasNextPage} nodes{ number } } } } } }'
```

측정 결과: `{"rl":{"cost":1},"repos":89,"more":false,"withIssues":19,"openAll":91,"openNonArchived":91,"anyIssuePaged":0}`

| 형태 | cost |
|------|------|
| repositories(100) × issues(100), 필드는 `number`만 | 1 |
| repositories(100) × issues(100) × `labels(first:20)` + `closedByPullRequestsReferences(first:5)` | **201** |
| 같은 중첩을 search(100)로 | 2 |

- 저장소별 방식은 `totalCount`와 `pageInfo`를 저장소마다 정확히 받을 수 있다. 1,000건 상한이 없고 커서 이동 문제도 저장소 단위로 좁혀진다. 대신 중첩된 연결마다 곱셈으로 비용이 커진다. 저장소가 100개를 넘거나 한 저장소의 이슈가 100건을 넘으면 2단계 페이지네이션이 필요하다.
- `organization(login:)`은 존재하지 않는 조직이면 `NOT_FOUND` 오류를 낸다(측정 5의 `repository` 사례와 같은 유형). search처럼 0건으로 넘어가지 않는다.
- archived 필터는 search에서는 `archived:false` 한정자로 걸고, 저장소별 방식에서는 `isArchived`로 클라이언트에서 걸러야 한다. 측정 시점에는 archived 저장소에 열린 이슈가 없었다.

## 8. `Issue.closedByPullRequestsReferences`

**스키마(introspection)**

- 설명: "List of open pull requests referenced from this issue"
- 인자: `includeClosedPrs`(기본 `false`, "Include closed PRs in results"), `orderByState`, `userLinkedOnly`("Return only manually linked PRs"), `excludeUserLinked`, `first`/`last`/`after`/`before`

**문서** (https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue)

- 키워드는 "interpreted only when the pull request targets the repository's default branch."
- 다른 저장소 연결: 키워드는 `OWNER/REPOSITORY#ISSUE-NUMBER` 형식을 쓴다. 이슈 사이드바에서는 "The issue can be in a different repository than the linked pull request"이고, PR 사이드바에서는 "must be in the same repository"다.
- 수동 연결에는 write 권한이 필요하고, PR 하나에 이슈를 "up to ten"개까지 연결할 수 있다.
- 커밋 메시지 키워드는 머지 때 이슈를 닫지만 "the PR isn't listed as linked"다.
- 검색 한정자 `linked:pr`는 "linked to a pull request by a closing reference"인 이슈만 고른다.

**측정** (illuwa-soft 열린 이슈 91건, 닫힌 이슈 100건 표본)

| 표본 | 연결 PR이 있는 이슈 (기본값) | 연결 PR이 있는 이슈 (`includeClosedPrs:true`) | 기본값에서 나온 PR 상태 | 수동 연결 | 다른 저장소 PR |
|------|------|------|------|------|------|
| 열린 이슈 91 | 5 | 5 | OPEN 3, MERGED 2 | 0 | 0 |
| 닫힌 이슈 100 | 16 | 16 | MERGED 16 | (측정 안 함) | 0 |

- 기본값(`includeClosedPrs:false`)에도 **MERGED PR이 포함된다**. 여기서 "closed"는 머지되지 않고 닫힌 PR을 가리키는 것으로 보인다(관찰 결과이며, 표본에 머지 없이 닫힌 PR이 없어 차이를 직접 확인하지는 못했다). 카드에 "열린 PR" 표시를 하려면 `state == OPEN`으로 따로 걸러야 한다.
- 비용: 중첩해도 search 기준 cost가 2~3이었다.
- 권한: 측정 계정(admin)은 비공개 저장소 PR도 볼 수 있었다. 이슈는 볼 수 있지만 연결된 PR이 있는 저장소는 볼 수 없는 토큰에서 어떻게 동작하는지(PR이 빠지는지, 오류가 나는지)는 문서와 측정 모두 없다. 미확인 사항이다.

## 설계에 주는 함의

결정이 아니라 사실에서 나온 제안이다.

1. **기본 조회 전략**: 조직당 GraphQL `search(query:"org:<org> is:issue state:open archived:false sort:updated-desc", type: ISSUE, first: 100)`에 `issueCount`와 `pageInfo{hasNextPage endCursor}`를 함께 받고 `hasNextPage`가 false가 될 때까지 페이지를 넘기는 방식이 가장 싸다. illuwa-soft 규모(91건)면 1회 요청에 1~2 point다. 저장소별 방식은 라벨 같은 필드를 중첩하면 cost가 약 100배(201)라서 교차 검증이나 대체 수단으로 남겨 둘 만하다.
2. **완전성 판정은 `hasNextPage`가 아니라 개수 비교로 한다**: 받은 고유 노드 수가 `issueCount`보다 적으면 결과가 잘렸다는 뜻이다. `issueCount > 1000`이면 상한 초과다. 두 경우 모두 오류 없이 `hasNextPage:false`가 오므로 UI가 직접 "N건 중 M건 표시"를 보여 줘야 한다. 상한을 넘으면 쿼리를 쪼개거나(예: `repo:` 또는 `label:` 단위) 저장소별 방식으로 넘어가는 길이 있다.
3. **조회 대상 검증을 따로 한다**: search는 존재하지 않거나 접근할 수 없는 조직에 대해 exit 0, 0건을 돌려준다. 같은 요청에 `organization(login:$org){ id }`를 별칭으로 넣으면 NOT_FOUND가 `errors`로 드러난다. 다만 그러면 5번 동작 때문에 exit 1이 되므로, stdout에서 `data`와 `errors`를 직접 파싱해야 한다.
4. **부분 실패 처리**: 현재 `gh()` 래퍼는 non-zero exit이면 stdout을 버린다. 조직 여러 개를 별칭으로 한 요청에 묶으면 한 조직의 오류가 전체 보드를 비워 버린다. 그러니 조직마다 요청을 나누거나, `error.stdout`의 `data`와 `errors[].path`로 별칭별 성공과 실패를 가려 UI에 조직 단위 오류를 표시하는 쪽이 낫다.
5. **페이지 사이 변동**: 커서가 오프셋이라 조회 도중 이슈가 갱신되면 같은 항목이 다시 나오거나 빠질 수 있다. id로 중복을 없애고(`mergeItems`가 이미 하고 있다), 마지막에 개수를 `issueCount`와 다시 비교해 어긋나면 "갱신 중 변동, 새로고침 필요" 같은 신호를 줄 수 있다.
6. **UI가 알려야 할 상태**
   - (a) 정상: 받은 수와 `issueCount`가 같음
   - (b) 일부만 받음(잘림이나 변동): 받은 수 < `issueCount`
   - (c) 상한 초과: `issueCount > 1000`
   - (d) 조직 단위 오류: `errors` 또는 exit 1, stderr 메시지
   - (e) 권한 범위 한계: 볼 수 있는 저장소 기준의 결과임을 알림. SSO `partial-results` 헤더는 `gh api -i`로만 볼 수 있다.
7. **연결 PR 표시**: `closedByPullRequestsReferences(first:N)`의 기본값에는 MERGED가 섞여 나오므로 표시 규칙(열린 PR만인지, 머지된 PR까지인지)을 정한 다음 `state`로 걸러야 한다. 키워드 연결은 기본 브랜치를 향한 PR에만 생기고, 커밋 메시지 키워드는 연결로 잡히지 않는다.

## 출처

- GraphQL 스키마 introspection(`Query.search`, `SearchResultItemConnection`, `SearchType`, `IssueSearchType`, `Issue.closedByPullRequestsReferences`), 2026-11-25 `gh api graphql`로 조회
- https://docs.github.com/en/rest/search/search
- https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api
- https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api
- https://docs.github.com/en/search-github/getting-started-with-searching-on-github/sorting-search-results
- https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests
- https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api
- https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue
- https://github.com/cli/cli/blob/v2.97.0/pkg/cmd/api/api.go (`processResponse`, `parseErrorResponse`)
- 이 저장소 `github-board/server/board.ts` (`gh`, `describeGhFailure`, `multiSearchQuery`, `mergeItems`, CHECKS_QUERY 주석)
