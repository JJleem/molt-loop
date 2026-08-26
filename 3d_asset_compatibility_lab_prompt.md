# 3D Asset Compatibility Lab PoC 개발 프롬프트

나는 **다양한 3D 파일을 업로드하면 파일의 데이터 구조를 자동 분석하고, 변환 가능한 포맷을 판별한 뒤, 여러 포맷으로 변환하고, 변환 전/후 결과를 한 페이지에서 동시에 확인·비교할 수 있는 웹 기반 3D Asset Inspector / Converter**를 만들려고 한다.

이 프로젝트의 목표는 단순한 파일 변환기가 아니다.

최종적으로는 다음 흐름을 제공하는 **3D Asset Compatibility Lab**을 만든다.

```text
3D 파일 업로드
↓
파일 포맷 + 내부 데이터 타입 분석
↓
Mesh / Point Cloud / Gaussian Splat 판별
↓
가능한 변환 포맷만 표시
↓
변환 시 예상되는 데이터 손실 사전 안내
↓
여러 포맷으로 변환
↓
한 페이지에서 원본 + 변환본 Viewer 비교
↓
카메라 동기화
↓
기본 자동 QA
↓
용량 / 변환 시간 / 데이터 유지 여부 비교
↓
결과 다운로드
```

초기 버전에서는 서버를 만들지 말고 **가능한 작업은 모두 브라우저 또는 로컬 환경에서 처리**한다.

---

# 1. 핵심 목표

사용자가 지원되는 3D 파일 하나를 Drag & Drop 하면:

1. 파일 확장자를 확인한다.
2. 파일 내부 구조를 분석한다.
3. 실제 데이터 타입을 판별한다.
4. 변환 가능한 출력 포맷을 계산한다.
5. 변환 불가능한 포맷은 이유와 함께 비활성화한다.
6. 변환 시 손실될 수 있는 정보를 미리 알려준다.
7. 사용자가 개별 포맷 또는 Convert All을 선택할 수 있게 한다.
8. 변환된 결과를 원본과 함께 한 페이지에서 렌더링한다.
9. 모든 Viewer의 카메라를 동기화한다.
10. 파일 크기, 변환 시간, geometry/attribute 유지 여부를 비교한다.
11. 최소한의 자동 검증을 수행한다.
12. 결과물을 다운로드할 수 있게 한다.

---

# 2. 중요한 제품 원칙

이 프로젝트에서 가장 중요한 원칙은 다음과 같다.

## 확장자만 보고 판단하지 않는다

예:

```text
PLY
```

는 하나의 의미가 아니다.

PLY 내부에는 다음 중 하나가 들어 있을 수 있다.

```text
Triangle Mesh
Point Cloud
Gaussian Splat
Unknown
```

따라서 반드시 파일 내부 구조를 분석한다.

---

## 모든 변환이 가능한 것처럼 보여주지 않는다

예:

```text
OBJ
```

는 일반적으로 Triangle Mesh 데이터다.

이를:

```text
OBJ → PLY
```

로 변환하는 것은 가능하지만,

```text
OBJ → SOG
OBJ → SPZ
```

는 단순 포맷 변환만으로는 불가능하다.

SOG / SPZ는 Gaussian Splat 데이터가 필요하기 때문이다.

따라서 UI는 다음처럼 표현한다.

```text
Available

✓ PLY
✓ GLB
✓ STL
✓ FBX

Unavailable

✕ SOG
  Requires Gaussian Splat data

✕ SPZ
  Requires Gaussian Splat data
```

---

## 변환 성공과 정보 보존은 다르다

예:

```text
GLB → PLY
```

는 가능할 수 있다.

하지만 GLB가 가진:

```text
Geometry
Texture
Material
UV
Normal
Animation
Hierarchy
PBR Material
```

등의 모든 정보를 PLY가 그대로 보존하지 못할 수 있다.

따라서 변환 전에:

```text
Expected Data Loss

Geometry      Preserved
Normals       Preserved
Vertex Color  Preserved if available
Texture       May be removed
Material      May be removed
Animation     Unsupported
Hierarchy     Flattened
```

를 보여준다.

변환 후에는 실제 결과를 기준으로 다시 검증한다.

---

# 3. 기술 스택

기본 기술 스택:

- React
- TypeScript
- Vite
- Three.js
- 필요 시 React Three Fiber
- Web Worker
- WASM 사용 가능
- PlayCanvas
- SuperSplat
- splat-transform
- Open3D
- assimp 기반 라이브러리 검토 가능
- glTF Transform 검토 가능
- Tailwind CSS 또는 간단한 CSS
- Node.js 기반 로컬 CLI 사용 가능

중요:

**3D 포맷 변환 알고리즘을 처음부터 직접 구현하지 않는다.**

검증된 라이브러리 또는 CLI가 존재하면 적극적으로 활용한다.

---

# 4. 지원할 데이터 타입

최소 다음 3가지 타입을 구분한다.

## A. Triangle Mesh

특징:

```text
Vertices
Faces / Indices
Normals
UV
Material
Texture
Vertex Color
```

예상 포맷:

```text
PLY
OBJ
STL
GLB
GLTF
FBX
```

---

## B. Point Cloud

특징:

```text
Point Position
Optional RGB
Optional Normal
Optional Intensity
```

예상 포맷:

```text
PLY
PCD
XYZ
XYZRGB
PTS
LAS
LAZ
E57
```

일부 포맷은 브라우저에서 직접 변환하기 어려울 수 있으므로 초기 PoC에서는 지원하지 않아도 된다.

---

## C. Gaussian Splat

특징:

```text
Position
Scale
Rotation
Opacity
Color / SH Coefficients
```

예상 포맷:

```text
Gaussian PLY
Compressed PLY
SOG
SPZ
Gaussian GLB
Standalone HTML Viewer
```

---

# 5. 초기 입력 포맷

초기 PoC에서는 다음 입력 포맷을 우선 검토한다.

```text
PLY
OBJ
STL
GLB
GLTF
FBX
PCD
XYZ
PTS
```

단, 모든 입력 포맷을 한 번에 지원하려고 하지 않는다.

개발 우선순위는 다음과 같이 한다.

```text
1. PLY
2. GLB / GLTF
3. OBJ
4. STL
5. PCD / XYZ
6. FBX
7. 기타
```

---

# 6. PLY 자동 판별

PLY는 반드시 header를 분석한다.

## Gaussian Splat PLY 판별

예:

```text
property float x
property float y
property float z
property float opacity

property float scale_0
property float scale_1
property float scale_2

property float rot_0
property float rot_1
property float rot_2
property float rot_3

property float f_dc_0
property float f_dc_1
property float f_dc_2
```

이런 Gaussian 관련 property가 충분히 존재하면:

```text
Gaussian Splat
```

으로 판단한다.

---

## Mesh PLY 판별

예:

```text
element vertex 12345
element face 23456
```

face element와 vertex index 정보가 존재하면:

```text
Triangle Mesh
```

로 판단한다.

---

## Point Cloud PLY 판별

vertex는 존재하지만:

```text
element face
```

가 없고 Gaussian Splat property도 없다면:

```text
Point Cloud
```

로 판단한다.

---

## Unknown

어느 쪽인지 확실하지 않으면:

```text
Unknown PLY
```

로 표시한다.

억지로 변환하지 않는다.

---

# 7. 다른 포맷의 데이터 타입 판별

## OBJ

기본적으로:

```text
Triangle Mesh
```

로 처리한다.

단:

```text
v
vn
vt
f
```

정보를 분석해서 실제 geometry 정보를 표시한다.

---

## STL

기본적으로:

```text
Triangle Mesh
```

로 처리한다.

STL은 일반적으로:

```text
Geometry
Normal
```

중심이며:

```text
Texture
Material
Animation
Hierarchy
```

는 기대하지 않는다.

---

## GLB / GLTF

파일 내부를 분석해서:

```text
Mesh
Material
Texture
Animation
Node Hierarchy
Skin
Morph Target
```

등의 존재 여부를 표시한다.

초기에는 Mesh Asset으로 분류한다.

---

## PCD / XYZ / PTS

기본적으로:

```text
Point Cloud
```

로 처리한다.

---

# 8. Compatibility Matrix

코드 내부에 변환 가능성 Matrix를 둔다.

예:

```text
Triangle Mesh

PLY  → GLB
PLY  → OBJ
PLY  → STL
PLY  → FBX

OBJ  → PLY
OBJ  → GLB
OBJ  → STL

STL  → PLY
STL  → OBJ
STL  → GLB

GLB  → PLY
GLB  → OBJ
GLB  → STL
```

Gaussian:

```text
Gaussian PLY
↓
SOG
SPZ
Compressed PLY
Gaussian GLB
HTML
```

Point Cloud:

```text
PLY
↓
PCD
XYZ
PTS
LAS
E57
```

단, 실제 라이브러리 지원 여부를 확인하고 Matrix를 구성한다.

추측해서 지원하지 않는다.

---

# 9. 변환 가능성 계산

사용자가 파일을 업로드하면:

```text
Input Format
+
Asset Type
+
Available Attributes
```

를 기반으로 변환 가능한 포맷을 계산한다.

예:

```text
model.glb

Type:
Triangle Mesh

Contains:
Geometry ✓
Normals ✓
UV ✓
Texture ✓
Material ✓
Animation ✓
```

출력:

```text
PLY
Available
Data loss expected

OBJ
Available
Some material differences possible

STL
Available
Texture / material / UV will be lost

SOG
Unavailable
Requires Gaussian Splat data
```

---

# 10. Data Loss Prediction

각 포맷의 capability metadata를 정의한다.

예:

```ts
type FormatCapability = {
  geometry: boolean;
  normals: boolean;
  vertexColors: boolean;
  uv: boolean;
  textures: boolean;
  materials: boolean;
  animation: boolean;
  hierarchy: boolean;
  gaussianData: boolean;
  pointCloud: boolean;
};
```

입력 포맷과 출력 포맷의 capability를 비교해서:

```text
Preserved
Potentially Lost
Unsupported
```

를 계산한다.

---

# 11. 업로드 후 Asset Summary

파일을 업로드하면 다음 정보를 표시한다.

예:

```text
room.ply

Format
PLY

Asset Type
Gaussian Splat

File Size
1.82 GB

Splats
18,423,991

Properties
x
y
z
opacity
scale_0
scale_1
scale_2
rot_0
...

Bounding Box
X 34.82
Y 12.14
Z 21.09
```

Mesh 예:

```text
chair.glb

Format
GLB

Asset Type
Triangle Mesh

File Size
127 MB

Vertices
1,203,331

Triangles
2,401,020

Materials
7

Textures
11

Animations
0
```

---

# 12. 파일 분석은 가볍게 시작

대용량 파일 때문에 브라우저가 멈추지 않게 한다.

가능하면:

```text
Header
Metadata
Index
Chunk
```

부터 읽는다.

파일 전체 ArrayBuffer를 처음부터 여러 번 복사하지 않는다.

---

# 13. Gaussian Splat 변환

초기 Gaussian Splat 변환 대상:

```text
PLY
↓
SOG
SPZ
Compressed PLY
GLB
Standalone HTML
```

가능하면:

```text
PlayCanvas
SuperSplat
splat-transform
```

의 기존 구현을 활용한다.

직접 포맷 스펙을 다시 구현하지 않는다.

---

# 14. Mesh 변환

초기 Mesh 변환:

```text
PLY
OBJ
STL
GLB
```

사이에서 가능한 변환을 구현한다.

예:

```text
OBJ → PLY
OBJ → GLB
OBJ → STL

STL → PLY
STL → GLB

GLB → PLY
GLB → OBJ
GLB → STL

PLY → GLB
PLY → OBJ
PLY → STL
```

FBX는 이후 추가해도 된다.

---

# 15. Point Cloud 변환

추후 다음을 검토한다.

```text
PLY
PCD
XYZ
PTS
LAS
LAZ
E57
```

초기 PoC에서는:

```text
PLY
PCD
XYZ
```

정도만 먼저 지원해도 된다.

LAS / LAZ / E57은 필요 시 로컬 backend 또는 native CLI를 붙인다.

---

# 16. Convert Selected / Convert All

UI에:

```text
[ Convert Selected ]
[ Convert All Compatible ]
```

을 제공한다.

Convert All은:

```text
변환 가능한 모든 포맷
```

만 실행한다.

변환 불가능한 항목은 건너뛴다.

---

# 17. 변환 작업 Queue

대용량 3D 데이터를 동시에 여러 번 처리해서 RAM이 터지지 않도록 한다.

예:

```text
Max Concurrent Conversion
1
```

또는:

```text
2
```

정도로 제한한다.

상태:

```text
SOG
Converting 42%

SPZ
Waiting

GLB
Waiting

HTML
Waiting
```

---

# 18. Web Worker

가능한 변환 작업은 Web Worker로 옮겨:

```text
Main UI Thread
```

가 멈추지 않게 한다.

특히:

```text
Header Parsing
Geometry Analysis
Conversion
Hash
Validation
```

등을 Worker 후보로 둔다.

---

# 19. Viewer 구조

확장자별 Viewer를 만들지 않는다.

다음 3개 Viewer 계층을 만든다.

```text
MeshViewer
PointCloudViewer
GaussianSplatViewer
```

---

# 20. Mesh Viewer

대상:

```text
PLY
OBJ
STL
GLB
GLTF
FBX
```

가능하면 Three.js loader를 활용한다.

기본 기능:

```text
Orbit
Pan
Zoom
Wireframe
Bounding Box
Grid
Axis Helper
Reset Camera
```

---

# 21. Point Cloud Viewer

대상:

```text
PLY
PCD
XYZ
PTS
```

기본 기능:

```text
Point Size
Point Color
Bounding Box
Camera Controls
```

---

# 22. Gaussian Splat Viewer

대상:

```text
Gaussian PLY
Compressed PLY
SOG
SPZ
Gaussian GLB
```

가능하면 PlayCanvas 기반 구현을 우선 검토한다.

직접 Gaussian Renderer를 처음부터 구현하지 않는다.

---

# 23. Viewer Grid

원본 + 모든 변환본을 한 페이지에 보여준다.

예:

```text
┌────────────────────┐  ┌────────────────────┐
│ Original PLY       │  │ SOG                │
│                    │  │                    │
│     3D VIEWER      │  │     3D VIEWER      │
│                    │  │                    │
└────────────────────┘  └────────────────────┘

1.82 GB                103 MB


┌────────────────────┐  ┌────────────────────┐
│ SPZ                │  │ GLB                │
│                    │  │                    │
│     3D VIEWER      │  │     3D VIEWER      │
│                    │  │                    │
└────────────────────┘  └────────────────────┘
```

---

# 24. Grid Layout

선택 가능하게 한다.

```text
1 Column
2 Columns
3 Columns
Auto
```

---

# 25. Camera Sync

가장 중요한 비교 기능 중 하나다.

한 Viewer에서:

```text
Orbit
Pan
Zoom
FOV
```

을 변경하면 모든 Viewer에 동일하게 반영한다.

공유할 Camera State:

```text
position
quaternion
target
fov
zoom
```

다음 Toggle 제공:

```text
[✓] Sync Cameras
```

무한 update loop가 발생하지 않도록 한다.

---

# 26. Viewer Card

각 Viewer Card에는 다음 정보를 표시한다.

예:

```text
SOG

Format
SOG

Type
Gaussian Splat

File Size
103 MB

Original
1.82 GB

Reduction
94.3%

Conversion Time
31.2 sec

Splats
18,423,991

Validation
PASS
```

---

# 27. 원본 카드

원본에는:

```text
ORIGINAL
```

Badge를 표시한다.

---

# 28. 변환 전 예상 손실

예:

```text
GLB → STL

Expected Data Loss

Geometry      ✓
Normals       ✓
Vertex Color  ✕
UV            ✕
Textures      ✕
Materials     ✕
Animation     ✕
Hierarchy     ✕
```

사용자가 변환 전에 볼 수 있어야 한다.

---

# 29. 변환 후 실제 검증

초기에는 AI 품질 검증까지 하지 않는다.

다음 항목부터 검사한다.

## 파일 생성 여부

```text
PASS
FAIL
```

---

## 다시 Parse 가능한지

생성된 파일을 해당 Loader로 다시 읽는다.

```text
PASS
FAIL
```

---

## Bounding Box

원본과 결과의:

```text
Center
Width
Height
Depth
```

를 비교한다.

---

## Vertex / Face / Point / Splat Count

가능한 경우 비교한다.

예:

```text
Original Vertices
1,203,331

Converted Vertices
1,203,331
```

---

## Attribute 유지

예:

```text
Geometry       Preserved
Normals        Preserved
Vertex Colors  Preserved
UV             Lost
Textures       Lost
Materials      Lost
```

---

# 30. Validation Result

예:

```text
Conversion Result

GLB → PLY

File
PASS

Parse
PASS

Geometry
PASS

Scale
PASS

Normals
PASS

Vertex Color
PASS

Texture
LOST

Material
LOST

Animation
UNSUPPORTED

Overall
USABLE WITH DATA LOSS
```

---

# 31. Compare Mode

각 카드에:

```text
[ Compare ]
```

버튼을 제공한다.

선택하면:

```text
Original                  Converted

┌─────────────────┐      ┌─────────────────┐
│                 │      │                 │
│    3D Viewer    │      │    3D Viewer    │
│                 │      │                 │
└─────────────────┘      └─────────────────┘
```

큰 화면에서 비교한다.

Camera Sync는 항상 지원한다.

---

# 32. Difference View 추후 확장

추후 다음 기능을 추가할 수 있게 설계한다.

```text
Original Screenshot
Converted Screenshot
```

동일한 카메라 Pose에서 렌더링한다.

그 후:

```text
SSIM
PSNR
LPIPS
Pixel Difference
```

등으로 비교 가능하게 한다.

초기 PoC에서는 실제 구현하지 않아도 된다.

---

# 33. 파일 크기 비교

모든 결과에서:

```text
Original
1.82 GB

Converted
103 MB

Reduction
94.3%
```

를 표시한다.

반대로 더 커졌다면:

```text
Size Increase
+22.4%
```

라고 표시한다.

---

# 34. 변환 시간

각 변환별:

```text
Start Time
End Time
Elapsed
```

을 기록한다.

예:

```text
SOG
31.2 sec

SPZ
27.8 sec

GLB
48.3 sec
```

---

# 35. 테스트 데이터 기록

변환 결과를 내부적으로 다음 형태로 저장한다.

```ts
type ConversionResult = {
  sourceFormat: string;
  targetFormat: string;
  inputSize: number;
  outputSize: number;
  elapsedMs: number;
  status: "success" | "failed";
  validation: ValidationResult;
};
```

---

# 36. Download

각 변환 결과:

```text
[ Download ]
```

전체 결과:

```text
[ Download All ]
```

기능을 제공한다.

가능하면 Blob URL을 사용한다.

Object URL은 사용 후 revoke한다.

---

# 37. Standalone HTML

Gaussian Splat 계열에서는 가능하다면:

```text
Standalone HTML Viewer
```

출력을 지원한다.

사용자가 별도의 Viewer 설치 없이 브라우저에서 결과물을 확인할 수 있게 한다.

---

# 38. 메모리 관리

매우 중요하다.

3D 파일은:

```text
100 MB
500 MB
1 GB
5 GB+
```

까지 커질 수 있다.

따라서 다음을 반드시 고려한다.

```text
ArrayBuffer 중복 복사 최소화
Blob 중복 최소화
Object URL revoke
Geometry dispose
Material dispose
Texture dispose
GPU resource dispose
Worker terminate
Intermediate buffer release
```

---

# 39. 대용량 경고

예:

```text
Large File Detected

File Size
2.84 GB

This operation may require significant memory.
```

브라우저의 실제 RAM을 정확히 알 수 없는 경우:

```text
Estimated
```

라는 표현을 사용한다.

정확한 정보처럼 표시하지 않는다.

---

# 40. Error Handling

예:

```text
SPZ Conversion Failed

Reason
Required Gaussian property not found.

Missing
scale_2

Possible Causes

- This is not a Gaussian Splat PLY.
- File is corrupted.
- Unsupported PLY schema.
```

단순히:

```text
Failed
```

라고 끝내지 않는다.

---

# 41. 프로젝트 구조

예:

```text
src/

  components/
    FileDropzone/
    AssetSummary/
    FormatCompatibility/
    ConversionOptions/
    ConversionProgress/
    ViewerGrid/
    ViewerCard/
    ComparisonPanel/
    ValidationReport/

  viewers/
    MeshViewer/
    PointCloudViewer/
    GaussianSplatViewer/

  analyzers/
    assetAnalyzer.ts
    plyAnalyzer.ts
    gltfAnalyzer.ts
    objAnalyzer.ts

  converters/
    gaussian/
    mesh/
    pointcloud/

  compatibility/
    formatCapabilities.ts
    conversionMatrix.ts
    dataLossRules.ts

  workers/
    analysis.worker.ts
    conversion.worker.ts
    validation.worker.ts

  validation/
    geometryValidator.ts
    attributeValidator.ts
    fileValidator.ts

  utils/
    fileSize.ts
    boundingBox.ts
    timer.ts

  types/
    asset.ts
    format.ts
    conversion.ts
    validation.ts

  store/
    assetStore.ts
```

---

# 42. 핵심 Type 설계

예:

```ts
type AssetType =
  | "mesh"
  | "point-cloud"
  | "gaussian-splat"
  | "unknown";
```

```ts
type AssetInfo = {
  fileName: string;
  format: string;
  assetType: AssetType;
  fileSize: number;

  vertexCount?: number;
  faceCount?: number;
  pointCount?: number;
  splatCount?: number;

  hasNormals?: boolean;
  hasVertexColors?: boolean;
  hasUV?: boolean;
  hasTextures?: boolean;
  hasMaterials?: boolean;
  hasAnimations?: boolean;
  hasHierarchy?: boolean;
};
```

---

# 43. MVP Phase

한 번에 모든 것을 구현하지 않는다.

## Phase 1

```text
Drag & Drop
↓
파일 포맷 판별
↓
PLY 내부 타입 판별
↓
Asset Summary
```

---

## Phase 2

```text
Gaussian PLY Viewer
```

원본이 실제로 보이는지 확인한다.

---

## Phase 3

```text
Gaussian PLY
↓
SOG
```

단 하나의 변환부터 성공시킨다.

---

## Phase 4

```text
Original PLY
vs
SOG

Side-by-Side
+
Camera Sync
```

---

## Phase 5

Gaussian 변환 확장:

```text
SPZ
GLB
Compressed PLY
HTML
```

---

## Phase 6

```text
Convert All
+
File Size
+
Conversion Time
+
Basic Validation
```

---

## Phase 7

Mesh 입력 지원:

```text
OBJ
STL
GLB
PLY
```

---

## Phase 8

양방향 Mesh 변환:

```text
OBJ ↔ PLY
STL ↔ PLY
GLB ↔ PLY

OBJ → GLB
STL → GLB
GLB → STL
```

실제 라이브러리 지원 범위 기준으로 구현한다.

---

## Phase 9

Data Loss Prediction 구현.

예:

```text
GLB → PLY

Texture
May be lost

Animation
Will be lost
```

---

## Phase 10

Point Cloud 지원 검토.

---

# 44. 하지 말아야 할 것

초기 단계에서는 다음을 하지 않는다.

```text
로그인
회원가입
결제
DB
클라우드 저장
AWS
Kubernetes
관리자 페이지
복잡한 API 서버
AI 품질 평가
모든 3D 포맷 지원
직접 3D 파일 스펙 구현
직접 Gaussian Renderer 구현
```

---

# 45. UI 방향

개발자 도구 느낌으로 만든다.

예:

```text
3D ASSET LAB

Inspect · Convert · Compare

[ Drop 3D Asset Here ]
```

파일 로드 후:

```text
room.ply

PLY
Gaussian Splat

1.82 GB

18.4M Splats

Compatible Formats

✓ SOG
✓ SPZ
✓ GLB
✓ Compressed PLY
✓ HTML

✕ STL
  Requires Triangle Mesh
```

---

# 46. 최종 비교 화면 예시

```text
ORIGINAL PLY

1.82 GB
18.4M Splats

┌─────────────────────┐
│                     │
│      3D VIEWER      │
│                     │
└─────────────────────┘


SOG

103 MB
94.3% Smaller
31.2 sec
PASS

┌─────────────────────┐
│                     │
│      3D VIEWER      │
│                     │
└─────────────────────┘


SPZ

180 MB
90.1% Smaller
27.8 sec
PASS

┌─────────────────────┐
│                     │
│      3D VIEWER      │
│                     │
└─────────────────────┘
```

---

# 47. Mesh 변환 화면 예시

```text
INPUT

model.glb

Triangle Mesh
127 MB

Geometry       ✓
Normals        ✓
UV             ✓
Textures       ✓
Materials      ✓
Animations     ✓


OUTPUT OPTIONS

PLY

Expected Data Loss

Geometry       ✓
Normals        ✓
Vertex Colors  ✓
UV             ⚠
Textures       ✕
Materials      ✕
Animations     ✕


STL

Expected Data Loss

Geometry       ✓
Normals        ✓
UV             ✕
Textures       ✕
Materials      ✕
Animations     ✕
```

---

# 48. PoC 성공 기준

다음 시나리오가 실제로 동작하면 1차 PoC 성공으로 본다.

```text
1. 사용자가 PLY 파일을 Drag & Drop 한다.

2. 프로그램이 Mesh / Point Cloud / Gaussian Splat 중 하나로 판별한다.

3. 원본 파일을 Viewer에서 보여준다.

4. 해당 데이터 타입에서 가능한 변환 포맷만 보여준다.

5. Gaussian PLY라면 최소 SOG / SPZ / GLB 중 2개 이상 변환한다.

6. 원본과 변환 결과를 같은 페이지에 표시한다.

7. Viewer들의 Camera Pose가 동기화된다.

8. 파일 크기와 변환 시간을 비교한다.

9. 변환 결과를 다시 Parse해 정상 파일 여부를 확인한다.

10. 결과물을 다운로드한다.

11. OBJ / STL / GLB 같은 Mesh 파일 하나를 입력한다.

12. Mesh 파일을 PLY로 변환한다.

13. 원본과 PLY 결과를 같은 화면에서 비교한다.

14. 변환 시 손실된 Attribute를 보여준다.
```

---

# 49. 최종 제품 방향

최종 목표는:

```text
3D Converter
```

가 아니다.

최종 방향은:

```text
3D Asset Compatibility Lab
```

이다.

사용자가 3D 파일을 넣으면:

```text
What is this file?
↓
What data does it contain?
↓
What can I convert it to?
↓
What will be lost?
↓
Convert
↓
Compare visually
↓
Validate
↓
Download
```

까지 한 번에 처리하는 도구를 만든다.

---

# 50. 개발 방식

바로 모든 코드를 한꺼번에 작성하지 마라.

반드시 다음 순서로 진행한다.

1. 현재 프로젝트 상태를 확인한다.
2. 사용할 라이브러리를 조사한다.
3. 각 라이브러리의 실제 지원 포맷을 확인한다.
4. 브라우저에서 가능한 것과 Node / CLI가 필요한 것을 나눈다.
5. Architecture를 먼저 제안한다.
6. Phase 1부터 구현한다.
7. 각 Phase가 실제 실행되는지 확인한다.
8. 성공한 뒤 다음 Phase로 넘어간다.

각 단계마다 다음을 간단히 정리한다.

```text
현재 구현된 것

테스트 방법

현재 제약

다음 단계
```

라이브러리 API와 지원 포맷을 추측하지 말고 **현재 설치 버전과 공식 문서를 확인하고 구현한다.**

---

# 가장 중요한 원칙

처음부터:

```text
모든 3D 파일
→
모든 3D 포맷
```

을 목표로 하지 않는다.

먼저 다음 두 가지 흐름을 완성한다.

## Flow A

```text
Gaussian PLY
↓
SOG / SPZ / GLB
↓
한 페이지 비교
↓
Camera Sync
↓
기본 QA
```

## Flow B

```text
GLB / OBJ / STL
↓
Mesh 분석
↓
PLY 변환
↓
한 페이지 비교
↓
Attribute 손실 표시
```

이 두 흐름이 제대로 동작한 뒤 지원 포맷을 확장한다.

목표는 **“단순히 변환되는가?”가 아니라 “어떤 3D 데이터이고, 어디까지 호환되고, 변환 후 무엇이 유지되거나 손실됐는지 사용자가 이해할 수 있는가?”**를 검증하는 것이다.
