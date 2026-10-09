# ᄒᆞᆫ칸 (Hankan)

ᄒᆞᆫ칸 (hankan) is a webapp to quickly fill in government-issued forms in `.hwp` and `.hwpx`. It does NOT aim to replace full Hanword; only to make-form filling easier and painless.

## Provenance

For HWP/HWPX format semantics, serialisation, parsing, rendering, and compatibility behaviour, the only authoritative sources are files under `/provenance`.

Do not search the Internet, inspect existing HWP implementations, consult third-party HWP libraries, or use pre-existing reverse-engineered format descriptions for these purposes.

General-purpose programming knowledge and documentation for unrelated technologies may be used normally.

- Open HWP spec sheets. Namely, `한글문서파일형식_5.0_revision1.3.pdf`, `한글문서파일형식_배포용문서_revision1.2.pdf`, `한글문서파일형식_수식_revision1.3.pdf`, `한글문서파일형식_차트_revision1.2.pdf`, `한글문서파일형식3.0_HWPML_revision1.2.pdf`, all acquired through Hancom Support (https://www2.hancom.com/support/downloadCenter/hwpOwpml); Usage condition in verbatim:
> 그리고, 본 문서 및 본 문서에 기재된 내용을 참고하여 개발한 결과물에 대한 모든 저작권은 결과물을
> 개발한 개인 또는 단체에 있을 것입니다. 그러나 반드시 개발 결과물에 “본 제품은 한글과컴퓨터의
> ᄒᆞᆫ글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.”라고 제품 내 유저인터페이스, 매뉴얼,
> 도움말 및 소스에 모두 기재하여야 하며 제품이 이러한 구성물이 없을 시에는 존재하는 구성물에만
> 기재합니다.

- KS X 6101: 개방형 워드프로세서 마크업 언어(OWPML) 문서 구조. Machine-readable transformation provided by standard.go.kr

- Corpus of HWP, and its rendered version in JPGE. The HWP/JPEG corpus may be used only as an input/output compatibility and regression corpus.

### Things (not) to do

- Do not use existing HWP/HWPX parsing, rendering, conversion, or document-generation libraries, regardless of license.
- Do not inspect their source code, tests, documentation, issue trackers, or generated output to infer HWP behavior.
- The required Hancom attribution must appear in every applicable user-facing distribution surface, including:
  a. web application's help/about information
  b. CLI --help or documentation
  c. source distribution
  d. packaged documentation
Do not remove or paraphrase the required attribution.
  
## Goal

Provide following components

- CLI for automated mass form-filling
  "mass operation" means two things simultaneously:
    a. same form, multiple output
    b. filling in similar but different forms (something like your name and address is mandatory for many forms)
- Semi-visual form filler webapp implemented in pure JS, with PWA

### Not a goal

> Incompleteness is a feature here

- anything more than form-filling
- mini wordprocessor

### CLI

Something like:

```hankan form.hwp people.csv --output out/```
```hankan --input ./this_dirty_forms_i_need_to_fill_up aboutme.csv --output this_dirty_forms_out/```

## Webapp

Under `webpage-worker` (Cloudflare pages/worker)

Add disclaimer: we're trying our best to make it just work, but it's still possible the resulting form might be skewed. Please check with external tools such as hancom docs viewer if it's an important document.

## The engine structure

Internally this is a document transformer, something like this:

```
HWP
 │
 ▼
HWP structure
 │
 ├── immutable document content
 │
 └── editable fields
        │
        ▼
     form data
        │
        ▼
   minimal mutations
        │
        ▼
       HWP
```

The UI is merely a convenient interface to that transformation.

Never reconstruct the entire document unnecessarily. Preserve all content and structure that the filler does not need to modify.

## Transparency

The whole operation need to be sufficiently transparent such that Hancom's legal team can easily and quickly inspect and find out this is "truly clean".

To aid legal audition, write a PROVENANCE.md generated/maintained alongside CLAUDE.md, documenting which source supports each major subsystem. Then an auditor can go:

```
HWP CFB parsing       → spec §...
record headers        → spec §...
text encoding         → spec §...
table representation  → spec §...
rendering regression  → corpus/
```

The HWP reading and JPEG rendering was done on physically different computer (a Windows machine) than the form filler is being developed on (a Linux machine), and nothing other than `.hwp`, `.hwpx`, and `.jpeg` is shared between two machines. The Linux workstation has no Hancom products installed.

## No infringing intellectual properties

The company's name and their brainchildren (e.g. 한글과컴퓨터, 한컴오피스, ᄒᆞᆫ글) must not be used to name and *advertising* ours (use alternatives such as "한글문서"; it is a bloody generic word that everyone knows what it means).
