# 포크 정체성 전환 검증 — 2026-11-26

대상: [포크 정체성 전환과 서버 도우미 공개](https://github.com/illuwa-soft/paseo-plugins/issues/12).
기준은 `5248df5af84b516ebf4c8936f70c10d796ddb0fd`이며, macOS / Node 26.5.0 / npm 11.17.0 / Paseo 0.17.3에서 실행했다.

## 구현과 인수 기준

- `illuwa-github-board`, `@illuwa-soft/paseo-github-board`, `0.12.0`, `GitHub (illuwa)`로 전환했다.
- `gh`, `GhSearchNode`, `toItem`을 공개했다. `server/board.ts`는 세 `export` 추가를 제외하면 기준 파일과 동일하다.
- 폴더명은 `github-board`이므로 CI의 폴더 목록은 유지했다. `publish.yml`은 변경하지 않았다.
- 새 id의 설정·데이터를 사용하며 upstream 데이터는 이관하지 않는다.
- reload·개인 보드 실행, 해당 플러그인 typecheck·테스트, 버전 일관성, 기존 서버 동작 보존을 검증했다.
- 전체 저장소 검사 완료는 [firstmate 테스트 후속](https://github.com/illuwa-soft/paseo-plugins/issues/22)에 막혔다. 이슈에 native blocked-by를 기록했다.

## 로컬 검사

각 폴더에서 `npm ci`, `npm run typecheck`는 모두 exit 0.

| 폴더 | `npm test` 결과 |
|---|---|
| skills | 112 통과 |
| github-board | 122 통과 |
| launchd-jobs | 67 통과 |
| herald | 134 통과 |
| model-pricing | 102 통과 |
| firstmate | 297 통과, 1 실패 |

`firstmate/server/watches.test.ts`의 프로세스 그룹 종료 테스트는 `child.pid` ENOENT로 실패했다.
새로 재시도해도 실패했고 깨끗한 기준 소스에서도 재현했다. 자식 준비보다 300ms 타임아웃이 빠른 테스트 가정 문제이며, 제품 종료 결함은 입증되지 않았다.
다른 플러그인 소스는 수정하지 않았다. CI의 Ubuntu / Node 24와 이번 실행 환경은 다르다.

추가로 전체 `check-plugin-consistency.mjs`, `check-lucide-icons.mjs`, `github-board`의 `npm pack --dry-run`, `git diff --check`가 통과했다.
SDK 타입 가드와 host-imports 테스트는 해당 typecheck·테스트에 포함된다.

## 격리 실행·브라우저 증거

[운영 설치 경로 결정](https://github.com/illuwa-soft/paseo-plugins/issues/6#issuecomment-7152536096)에 따라 worktree를 운영 설치 경로로 쓰지 않았다.
임시 소스 복사본과 별도 home·포트 `127.0.0.1:6798`을 사용했다. relay는 끄고 web UI만 켰다.
운영 데몬 `127.0.0.1:6767`은 재시작하거나 설치를 변경하지 않았다.

1. 기준 원본 `github-board`와 후보 `illuwa-github-board`를 같은 격리 데몬에 설치했다. 두 서버 모두 `running`.
2. `paseo plugin reload illuwa-github-board --home <격리 home>` 성공 뒤 브라우저에서 새 사이드바 이름과 보드를 열었다.
3. 실제 `gh` 조회가 성공했다. 원본과 후보 모두 저장소 14개, Issues 29 / Draft PRs 11 / Open PRs 19 / Discussions 4를 표시했다.
4. 카드 상세 열기·상세 새로고침·닫기, 댓글 7건 로딩, 보드 새로고침의 로딩→완료 전환을 확인했다.
5. 후보의 이슈 프롬프트를 테스트 문구로 저장하고 편집기로 돌아와 값을 다시 읽었다. 원본 편집기는 기존 기본값을 유지했다. 이 변경은 폐기할 격리 home에만 있다.
6. 1440×1000 라이트·다크와 390×844 모바일 에뮬레이션 다크 화면을 직접 확인했다. 좁은 화면에서 칸 탭과 Draft PRs 전환이 동작했다. 물리 iOS·Android 검증은 아니다.

뷰포트만 600px로 줄인 데스크톱 에뮬레이션은 원본과 후보 모두 데스크톱 칸을 좁게 표시했다. 모바일 에뮬레이션을 켜고 다시 로드하면 칸 탭이 표시된다. 이 둘을 같은 compact 검증으로 취급하지 않았다.

스크린샷은 관계없는 비공개 저장소 제목을 포함하므로 커밋하지 않았다. 로컬 증거 위치:
`/private/var/folders/ct/gw_8mtc16v786gjqqlmwsrj80000gn/T/opencode/issue12-evidence/`
(`wide-light.png`, `detail-dark.png`, `mobile-dark.png`, `plugins-running.json`).
이미지는 본 에이전트가 직접 확인했다. 판단 도구에는 이미지 분석을 맡기지 않았다.

## AFK 선택과 외부 변경

- 머지 전 실행 방법은 운영 설치 대신 격리 복사본으로 선택했다. 초기 운영 설치 제안은 사람의 경로 결정을 읽은 뒤 실행 전에 폐기했다.
- Actions API가 `enabled:true`였지만 기존 사람 결정은 비활성화였다. `PUT repos/illuwa-soft/paseo-plugins/actions/permissions`로 `enabled:false`를 적용하고 재조회했다.
- 복구 명령: `gh api --method PUT repos/illuwa-soft/paseo-plugins/actions/permissions -F enabled=true -f allowed_actions=all`. 기존 사람 결정이 바뀌지 않으면 복구하지 않는다.
- 원격 CI·npm 게시·태그·release·merge는 실행하지 않았다. Actions 비활성화에 따라 전체 로컬 검사로 확인했다.
- 임시 config와 플러그인 복사본 외에 운영 파일 변경은 없다. 검증 종료 시 이 실행 소유의 임시 데몬을 중지한다. 운영 home과 기존 설치는 그대로 둔다.

## 재개

[테스트 후속](https://github.com/illuwa-soft/paseo-plugins/issues/22)이 닫히면 기존 브랜치에 최신 `main`을 반영하고 전체 검사 및 영향받은 실행 검증을 다시 수행한다.
그 결과가 통과하면 기존 PR을 ready로 바꾸고 `ready-for-agent`를 붙여 리뷰에 넘긴다.
