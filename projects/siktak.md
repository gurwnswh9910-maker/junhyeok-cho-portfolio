# 우연한 식탁 | 신청에서 예외 처리까지 연결한 운영 MVP

[포트폴리오 첫 화면으로](../README.md) · [공개 전체 코드](https://github.com/gurwnswh9910-maker/siktakpublic)

## 문제

소셜다이닝은 매칭만 성공해도 끝나지 않습니다. 신청·결제 상태, 식당과 안내, 취소·대기자·실패, 실제 참석과 다음 만남의 피드백이 이어져야 합니다. 이 흐름을 한 시스템 안에서 다루고 운영자는 예외에 집중하도록 구현한 프로젝트입니다.

## 구현한 흐름

```text
신청 → 모의 결제 → 자동 매칭 → 가상 식당 배정
     → 단체방·안내 → 대화 주제 → 체크인 → 후기 → 다음 매칭 반영
```

- 날짜·지역·4~6명·나이 차·차단/신고/비선호는 필수 조건으로 다룹니다.
- 선호 점수와 필수 조건을 분리하고, HiGHS 정수계획 solver로 최적해를 확인한 결과를 확정합니다.
- 매칭 실패는 대안 일정·이용권 보관·모의 환불로 이어집니다.
- DB 작업 큐와 worker가 예약 안내·후기 요청·실패 재시도를 수행합니다.
- 운영자는 예외 대시보드, 사유·감사 기록을 남기는 수정, 대기자 전환으로 개입합니다.

## 검토할 파일

- [README](https://github.com/gurwnswh9910-maker/siktakpublic/blob/main/README.md): 전체 구조와 시연 순서.
- [PRD-VERIFICATION](https://github.com/gurwnswh9910-maker/siktakpublic/blob/main/PRD-VERIFICATION.md): 요구사항별 구현·검토 접점.
- [DEPLOY](https://github.com/gurwnswh9910-maker/siktakpublic/blob/main/DEPLOY.md): 배포·실행 안내.

Next.js 16, React 19, TypeScript, Prisma 6, PostgreSQL 17, HiGHS(WASM)를 사용합니다. 이 포트폴리오에서 제 역할은 업무 흐름·조건·예외 기준을 정의하고 AI를 활용해 구현·검토한 것으로 설명합니다.

## 범위

모의 결제·환불과 가상 식당 배정입니다. 실 PG, 실제 식당 예약, 실기기 푸시 수신, 소셜·휴대전화 인증, 학습형 추천은 완료했다고 제시하지 않습니다. 이번 포트폴리오 제작에서는 공개 README·기능별 검토 문서·접근 가능 여부를 확인했으며, 기존 앱 전체 테스트나 배포 데모의 로그인 흐름을 다시 실행하지 않았습니다. 심사자는 로그인 없이 위 코드·문서를 검토할 수 있습니다.
