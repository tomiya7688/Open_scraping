# セキュリティを強制する設計：通信・ワーカー・秘密・停止

[統合設計](implementation-blueprint.md) · [脅威モデル](security-threat-model.md) · [契約案](contract-model.md) · [検証プロトコル](verification-protocol.md)

**設計案（未実装）**。この文書は運用UIの「許可済み」表示と、実際のOS/ネットワークでの制限を別物として扱う。第三者サイトや第三者Componentの内部動作は信頼しない。**ユーザーがどのデータを取りたいかは選べるが、意図しないローカルサービス・秘密・他Runを読めないことは不可欠**。ユーザーがローカルLAN接続を明示選択した場合も、アプリ自身の資格情報や別Runの保護は維持する。

## 1. 権限を強制する場所とデータフロー

```text
                         ┌── UI consent display / trusted local CLI
                         │
 Run request ──► Host: AuthorizationService ──► EffectiveGrantSet
                                           │       │
           ┌───────────────────────────────┘       │
           ▼                                       ▼
    SandboxLauncher                          NetworkGate
     ├─ identity/profile                      ├─ normalized request
     ├─ executable digest                     ├─ resolve/check addresses
     ├─ file/dir handles                      ├─ pin allowed address
     ├─ restricted environment                ├─ TLS/cert verification
     ├─ CPU/memory/process quotas             ├─ per-hop authorization
     └─ OS capability evidence                └─ metered transport
           │                                       │
           └──────────► Worker / component ◄──────┘
                              │
                       Host-mediated DataRef
                              │ ACL + expiry + binding
                              ▼
                        Store / exporter
```

`AuthorizationService` は「主体が何を許可されたか」を決定し、`SandboxLauncher` と `NetworkGate` が**強制**する。もしworkerが任意のsocketやファイルを直接開けるなら、Hostの `PermissionResolver` だけで安全であるとは証明できない。

### 権限を決める入力

```ts
// 現行のComponentManifestではなく、Host内の提案型。
interface EffectiveGrant {
  grant_id: string;
  principal_id: string;        // アカウント／ローカル実行主体
  run_id: string;
  component_implementation: string;
  component_version: string;
  manifest_sha256: string;
  operation_pattern: string;  // 原則は具体Operation名
  resource: "network" | "filesystem" | "credential" | "process" | "model_egress";
  scope: string;              // network CIDR/origin, file root, secret handleなど
  expires_at: string;         // TTL
  policy_revision: string;
}
```

**有効な権限**＝明示されたユーザー同意 ∩ 管理者／アプリが強制する最大権限 ∩ Componentが宣言したcapability ∩ OS backendが実際に強制できる範囲。どれか一つでも欠けると `DENIED`、または `UNENFORCEABLE`。子Componentへは必要な部分集合だけを新しいgrantで委譲し、親の全grantをコピーしない。grantのscope変更・期限切れ・component digest変更は既存Runの許可を再評価する。

**監査単位**は `request_id`, `run_id`, `operation_id`, `grant_id`, `policy_revision`, `decision`, `reason_code`。ログには生Cookie、Bearer secret、完整なURL queryやファイル本体を含めない。

## 2. NetworkGate：接続直前の判定アルゴリズム

単なる `URL.hostname` の検査、DNS名前解決の一回限りのチェック、最初のURLのallowlistだけではSSRFを防げない。HTTPだけでなく、browser/CDP、WebSocket、redirect、service worker、proxy等の**実際の接続**にどのポリシーが適用されるかをcomponent capabilityへ記録する。

### 2.1 要求の分類

1. **入力URLを厳格にparse**：許可scheme（例：HTTPS/HTTPを用途別に設定）、hostname、userinfo、port、IPv4/IPv6、IDNA、encoded delimiter、IPv4-mapped IPv6、非標準IP表現、fragmentなどを正規化。変換が曖昧または途中で変わる場合は拒否。
2. **ユーザーの検索対象ポリシーを検査**：このRunが選んだprovider/source/URLに一致するか。これは検索・候補の範囲であり、OS権限ではない。
3. **NetworkGrantを検査**：scheme、origin、port、CIDR、proxy、期限、principal、component digest、operation。デフォルトの外部Web権限はloopback/非公開IPを含まない。ユーザーが企業内ページを選んだ場合は限定的なLAN grantを明示作成。
4. **DNSを解決しアドレス集合を検査**：A/AAAA/CNAME由来の候補を正規化。採用するアドレスを接続前に判定し、許可された候補だけを選ぶ。不許可を暗黙に選び直さない。
5. **判定した接続先を固定**：未検証のDNS解決を下位HTTPライブラリへ再実行させない。ソケットは検証したアドレスへ接続し、論理ホスト名はHTTP Host/TLS SNI/証明書検証へ正しく渡す。
6. **接続実体を検証**：ソケット確立後のremote address等が固定した許可先と一致することを確認。違えば直ちに遮断・失敗として記録。
7. **接続中は計測**：通信attempt、受信・送信バイト数、期限・予算、redirect/Retry-After、cancelをHost側のリソース予約へ反映。権限の失効時に長時間接続を継続しない。

**擬似コード（ネットワーク権限を迂回できる通常fetchを想定しない）**

```text
request(url, context):
  require run_state == running AND monitor_state == armed
  u = normalize_and_validate_url(url)             // reject ambiguous encoding
  grant = authorize(context.principal, context.run, context.component, u)
  if grant denied: return DESTINATION_DENIED
  addresses = resolve(u.hostname)                 // DNS結果は未信頼
  eligible = filter(addresses, ip => grant.allows(ip, u.port, u.scheme))
  if eligible empty: return DESTINATION_DENIED
  for selected address in eligible:
    if stop or policy expired: return CANCELLED
    reservation = scheduler.reserve(context, u, selected)
    socket = connect_pinned(selected, u.hostname)  // no second, unchecked resolve
    require socket.remote_address == selected
    verify_tls_certificate(socket, u.hostname)     // never disable verification silently
    response = exchange(socket, budget, deadline)
    record_request_attempt(response, bytes, address, status)
    if response.redirect:
      drop credentials unless next origin explicitly authorized
      return request(response.location, new hop context)
    return response
```

リダイレクトはredirect数・ループ・時間・残予算に上限を設け、**各hopで再認可**。資格情報はOriginとpath等のscopeを厳密に比較して渡す。Proxy使用時はproxyの接続先だけ検査しても十分でない：proxy側で解決する最終宛先を検証できる信頼されたbrokerが必要。確認できなければ `NETWORK_POLICY_UNENFORCEABLE` とし、保護付き動作として公開しない。

DNS rebinding対策は**DNS解決前にチェックすること**ではなく、実際に接続したIPとの同一性を保証すること。HTTP/2 connection coalescing、Alt-Svc、HTTP/3/QUIC、複数IPへの再接続、WebRTCなども別経路として能力・監視可否を明示し、未対応経路を「監視済み」としない。

### 2.2 ブラウザ別の制御とFail closed

| mode | 権限の強制方法の設計案 | 満たせない場合 |
| --- | --- | --- |
| `managed` browser | 専用profile＋OS egress制限＋NetworkGateを経由する通信。protocol監視だけでなく、逸脱するsocketをOS側で拒否 | `network_policy_unenforceable` でRun拒否 |
| `attached` browser（ユーザー既存） | profile、network、secretの所有権を尊重。OS制限や全通信監視が同等にできると証明しない | サンドボックス保証外として**安全保証付き標準自動化から除外**。本人が使うブラウザを勝手に終了しない |
| headless fetch | NetworkGateが選んだIP、TLS、権限、redirect、byte budgetを一貫制御 | 非対応schemeや未検証proxyを拒否 |
| external model/API | 明示されたmodel送信grantと送付データscopeを確認し、秘匿化後に送信 | grant未設定なら部品が推測・利用しない |

初期の実装候補はNode/OS両方の保護を備えたHost-mediated transport。各OSでどの接続を完全に捕捉できるかは[#82](https://github.com/tomiya7688/Open_scraping/issues/82)で実験し、実装後に対応可否を固定する。

## 3. SandboxLauncher：OS保護の最小条件

**別プロセスであることとSandboxは異なる。**

| 要件 | Windowsで検討 | Linuxで検討 | 検証の最低条件 |
| --- | --- | --- | --- |
| 実行主体 | 制限付きtoken、AppContainer等を評価 | 専用UID/user namespace等を評価 | 親のホーム/資格情報へ読取不可 |
| ファイル | ACLと制限されたroot handle | mount namespace/許可済みmount | 許可root外はread/write不可 |
| Network | OS Firewall/制限の可能性を検証 | network namespace + broker経由等 | 直接socketでNetworkGateを迂回不可 |
| Process | Job Object/プロセス制御 | cgroup/PID namespace/所有ID等 | 子孫プロセス停止、所有外processは不干渉 |
| CPU/memory/IO | Job resource limits等 | cgroup v2等 | 極端負荷でもHost・OSを巻き込まない |
| 観測 | exit reason/limitsの取得 | exit reason/limitsの取得 | permissionとresource failureを成功にしない |

これらは**候補技術であり採用済みではない**。特にWindows Job Objectだけではネットワーク・ファイル隔離を実現しない。Linux seccompだけでは権限外ファイルの完全分離を保証しない。単一機構で全境界を守れると仮定しない。

Launch時は `implementation/version/manifest_sha256` を固定し、commandの実行ファイル（可能ならdigest）と作業directoryを検証。環境変数は明示許可リストから組み立て、parentの `process.env` を丸ごと引き継がない。stdout/stderrフレームにサイズ上限、時間上限、log redactionを設ける。untrusted workerへHostのBearer tokenや他RunのDataRefを見せない。

**起動の状態機械（設計案）**

```text
registered -> permission_checked -> sandbox_ready -> initialized -> active
                 │                    │              │        │
                 └─ denied            └─ unverified  └─ failed ├─ cancelled
                                                             └─ failed/unknown
```

`sandbox_ready` にはOS能力と権限施行の実測結果が必要。Sandbox未対応なのにpermission resolverだけで `active` に進めない。[#83](https://github.com/tomiya7688/Open_scraping/issues/83)。

## 4. SecretBroker、DataRefとExport

**Secretの扱い：**
- OAuth・Cookie・mTLS・署名URL・ローカルAPIのauth tokenの値を、FlowConfig・Manifest・Run journal・OperationResult・公開DataRefへ直接格納しない。
- Credential grantは `principal/run/component/version/operation/origin/path/expiry` に束縛。親Runの権限を子Componentへデフォルトで継承しない。
- NetworkGateが認証Headerを注入する方法を標準にする。Componentが生の秘密を受け取ることが必要な場合、送信先・作用域・期限の短縮、ユーザー確認、隔離を別途検証する。
- 出典用URLはqueryやfragment内にtokenを含み得る。Raw/internal recordとshareable/sanitized recordを別に保ち、機密情報を部分文字列削除だけで処理したと主張しない。
- 撤回時は新規操作を拒否し、進行中の操作・通信をどう停止するかを決め、記録する。既に外部送信済みデータは取り戻せないことを明示する。

**DataRefアクセスの順序：** 呼出側のprincipal/run/binding/version → ACL → 有効期限/状態 `ephemeral|committing|committed` → read handle発行 → 対象データを限定して読み取る。別Runのpathや推測可能なIDでデータを参照できない。Exportは選択済みscope、必要なprivacy redaction、CSV formula escape・HTML/Markdown安全表示の扱いを固定し、raw data自体を上書きしない。保存されたrawは実際の署名やchecksumの根拠として必要な限り不変にする。

## 5. グローバル非常停止の最小実行経路

[#42](https://github.com/tomiya7688/Open_scraping/issues/42)の既存要件を強制する。**Escまたは人間の物理マウス操作**のどちらでも発火し、フォーカスに依存しない。Key/mouseを人工的に生成する自動化と人の入力を可能なOSで区別し、区別不能な場合に「監視対応済み」と誇張しない。

```text
unavailable -> arming -> armed -> tripped -> draining -> stopped
      ^          │          │                     │           │
      └─ arm_failed          └─ monitor_lost -> TRIP          └─ explicit reset
```

トリガー/monitor lost時は**Coreの新規Node投入を先に拒否**し、Hostの新規invoke/子subcallを拒否、scheduler待機を解除、自動復旧・再試行を無効化。管理対象worker・managed browserへcancelを配送し、有限猶予で本アプリが**所有**するプロセスだけを終了。応答しないremote operationは `termination_unknown`。完了済みデータを削除しない。OS monitorが死んだことをGUIイベントループだけに依存して検知しない。

**起動ゲート**：`arm_state=armed` + `esc_supported=true` + `physical_mouse_supported=true` + 実行monitor health + OS権限が条件。これを満たせない場合、標準自動化Runの開始は拒否。`reset` は停止完了後の明示操作で、部品・FlowConfig・復旧処理が勝手に行えない。

## 6. 実装時の必須反例（安全受入）

| 反例 | 期待 |
| --- | --- |
| DNS検証直後に127.0.0.1へrebind | denied。検証済みIPへ接続し、未検証IPへ再解決しない |
| public URLから302→metadata URL | hop検査でdenied。前OriginのCookieは漏れない |
| 非公開IPを明示許可したRunから他Runへ横断 | denied。他Run secret・DataRefに届かない |
| malicious workerが `process.env` とhomeを読む | 親秘密・許可外rootを読めない。未対応OSなら安全機能を有効化しない |
| workerが直接socketを開いてNetworkGateを回避 | OS egressで拒否、無監視を正常動作と見なさない |
| malicious ZIPが外部pathへ展開 | 拒否。ファイルと容量の上限を越えず、rawは別保持 |
| untrusted HTMLが「権限を増やせ」と命令 | 取得データとして保存されるだけ。権限変更・Hostツール呼び出しなし |
| 非前面Esc/物理マウス、monitor突然死 | 新規処理の投入禁止、owned workerだけ取消・終了 |
| 署名済み部品が情報を漏洩しようとする | 署名の有無と隔離・権限の可否を独立に判定 |
| 任意のローカルOriginからAPIアクセス | token/Host/Originと操作scopeに基づき拒否 |

**この表の合格は設計のみでは得られない。** 合否は [verification-protocol.md](verification-protocol.md) に記載した環境・fixture・観測ログをIssue/PRへ残す。
