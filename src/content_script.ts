import axios from "axios";
import { storage } from "./firebase";
import { ref, uploadBytes, getDownloadURL, listAll } from "firebase/storage";

type Subtitle = {
  from: string;
  to: string;
  subtitle: string;
};

type Sentence = {
  from: string;
  to: string;
  sentence_en: string;
  sentence_ja?: string;
};

const timeToNumber = (time: string) => {
  let timeFormatted = "";
  // HACK: 一時間超えのレクチャーの場合に正しく動作しない
  if (time.match(/^\d{2}\:\d{2}\:\d{2}\.\d{3}$/)) {
    // xx:xx:xx.xxxの形式
    // 先頭のxx:を消す
    timeFormatted = time.slice(3, time.length);
  } else timeFormatted = time;
  const minute = timeFormatted.split(":")[0];
  const second = timeFormatted.split(":")[1].split(".")[0];
  const millisecond = timeFormatted.split(":")[1].split(".")[1];
  return {
    minute: Number(minute),
    second: Number(second),
    millisecond: Number(millisecond),
    time_number:
      Number(minute) * 60 + Number(second) + 0.001 * Number(millisecond),
    time_string: time,
  };
};

// テキストから<>を取り除く
const removeTag = (text: string) => {
  return text.replace(/<("[^"]*"|'[^']*'|[^'">])*>/g, "");
};

const removeLineChar = (time: string) => {
  try {
    return time.replace(" line:15%", "");
  } catch (error: any) {
    console.log(time);
    throw Error(error);
  }
};

const isString = (value: any) => {
  return typeof value === "string" || value instanceof String ? true : false;
};

const sleep = (ms: number) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

// グローバル変数
let div = document.createElement("div"); // すべての要素はここに入る
let button1 = document.createElement("button"); // このレクチャーの字幕をダウンロードする（1つの.vttファイル）
let button2 = document.createElement("button"); // コース全体の字幕をダウンロードする（複数の.vttファイル）
let button3 = document.createElement("button"); // このビデオレクチャーをダウンロードする
let title_element: Node | any = null; // ページ左上のタイトル表示

// UI要素のページへの配置
async function inject_our_script() {
  // https://greasyfork.org/en/scripts/422576-udemy-subtitle-downloader-v3/discussions/110421
  // title_element = document.querySelector(
  //   'a[data-purpose="course-header-title"]'
  // );
  while (!title_element) {
    title_element = document.querySelector(
      '[data-purpose="course-header-title"]'
    );
    await sleep(1000);
  }

  let button1_css = `
    font-size: 14px;
    padding: 1px 12px;
    border-radius: 4px;
    border: none;
    color: black;
  `;

  let button2_css = `
    font-size: 14px;
    padding: 1px 12px;
    border-radius: 4px;
    border: none;
    color: black;
    margin-left: 8px;
  `;

  let div_css = `
    margin-bottom: 10px;
    display: flex;
  `;

  button1.setAttribute("style", button1_css);
  button1.textContent = "このレクチャーの字幕をダウンロードする";
  button1.addEventListener("click", download_lecture_subtitle);

  button2.setAttribute("style", button2_css);
  let num = await get_course_lecture_number();
  button2.textContent = `全コースの字幕をダウンロードする(${num}ドキュメント)`;
  button2.addEventListener("click", download_course_subtitle);

  button3.setAttribute("style", button2_css);
  button3.textContent = "このビデオレクチャーをダウンロードする";
  button3.addEventListener("click", download_lecture_video);

  div.setAttribute("style", div_css);
  div.appendChild(button1);
  div.appendChild(button2);
  div.appendChild(button3);

  insertAfter(div, title_element);
}

// このレクチャーの字幕をダウンロードする
async function download_lecture_subtitle() {
  await parse_lecture_data();
}

// 現在のレクチャーの字幕をダウンロードする
// how to call: await parse_lecture_data();
// ダウンロードし、.vtt字幕を取得します。
async function parse_lecture_data(
  course_id: string = "",
  lecture_id: string = ""
) {
  // 引数を渡さなかった（空文字の）場合は、現在のレクチャーとして扱われます
  const data = await get_lecture_data(course_id, lecture_id); // 現在のレクチャーのデータを取得する
  const lecture_id_from_fetched_data = data.id; // 取得したレクチャーデータから、このレクチャーのidを取得する
  const lecture_title = await get_lecture_title_by_id(
    lecture_id_from_fetched_data
  ); // レクチャーidでレクチャータイトルを検索する

  // 複数の言語の字幕データが入ってくるので、data.asset.captions.lengthが1以上になることもある
  const captions_en = data.asset.captions.find(
    (caption: any) => caption.video_label.indexOf("英語") !== -1
  );
  if (!lecture_title) throw Error("lecture_title is null");
  if (!captions_en) return; // 文字のみのレクチャー or 英語字幕がないレクチャーはここで返す
  let filename = `${safe_filename(lecture_title)}.vtt`; // ファイル名の構成
  save_vtt(captions_en.url, filename); // 直接保存
}

// コースのすべての字幕をダウンロードする
async function download_course_subtitle() {
  let course_id = get_args_course_id(); // URLからコースIDを取得
  let data = await get_course_data(); // URLから取得したコースIDとCookieから取得した認証情報を元にコース全体のデータを取得する
  let array = data.results; // レクチャー配列
  for (let i = 0; i < array.length; i++) {
    const result = array[i];
    if (result._class == "lecture") {
      let lecture_id = result.id;
      await parse_lecture_data(course_id, lecture_id);
      await sleep(2000);
    }
  }
}

// このビデオレクチャーをダウンロードする
async function download_lecture_video() {
  button3.textContent = "このビデオをダウンロードする（ダウンロード開始）";
  let data = await get_lecture_data(); // 現在のレクチャーのデータを取得する
  let lecture_id = data.id; // このレクチャーのidを取得する
  let lecture_title = await get_lecture_title_by_id(lecture_id); // idでタイトルを検索する

  let r = data.asset.media_sources[0];
  console.log("data", data);
  // console.log('data.asset.media_sources', data.asset.media_sources)
  // r => {
  //   type: "application/x-mpegURL",
  //   src: "https://www.udemy.com/assets/18738176/encrypted-files/out/v1/1c1e0dfe7de744749849c4c3df5e45b3/b6fdc5264b9047629c0ed790b2c7ecd3/b4ad6e003a0e45bd8935a17376a85b0a/index.m3u8?token=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJwYXRoIjoib3V0L3YxLzFjMWUwZGZlN2RlNzQ0NzQ5ODQ5YzRjM2RmNWU0NWIzL2I2ZmRjNTI2NGI5MDQ3NjI5YzBlZDc5MGIyYzdlY2QzL2I0YWQ2ZTAwM2EwZTQ1YmQ4OTM1YTE3Mzc2YTg1YjBhLyIsImV4cCI6MTY0MTQ5ODUwMX0.J6sGQg8l_JOeb4PxVOX6pPe6ArsQ4LCs98jxfnYROnU&provider=cloudfront&v=1",
  //   label: "auto",
  // };

  let url = r.src;
  let resolution = 1080; // r.label;
  let filename = `${safe_filename(lecture_title ?? "")}_${resolution}p.mp4`; // 构造文件名
  let type = r.type; // application/x-mpegURL

  // Response は Fetch API のインターフェイスで、リクエストのレスポンスを表します。
  fetch(url)
    .then((res: Response) => res.blob())
    .then((blob) => {
      downloadString(blob, type, filename);
      button3.textContent =
        "この動画レクチャーをダウンロードする（ダウンロード完了）";
    });
}

// あるノードの後に新しいノードを挿入する
function insertAfter(newNode: any, referenceNode: Node | null) {
  if (!referenceNode) throw Error("referenceNode is null");
  if (!referenceNode.parentNode)
    throw Error("referenceNode.parentNode is null");
  referenceNode.parentNode.insertBefore(newNode, referenceNode.nextSibling);
}

// レクチャーのデータを取得する
function get_lecture_data(
  course_id: string = "",
  lecture_id: string = ""
): any {
  return new Promise((resolve, reject) => {
    let access_token = getCookie("access_token");
    let bearer_token = `Bearer ${access_token}`;
    // 引数を渡さなかった（空文字の）場合は、現在のレクチャーとして扱われます
    fetch(get_lecture_data_url(course_id, lecture_id), {
      headers: {
        "x-udemy-authorization": bearer_token,
        authorization: bearer_token,
      },
    })
      .then((response) => response.json())
      .then((data) => {
        resolve(data);
      })
      .catch((e) => {
        reject(e);
      });
  });
}

// 指定された名前のCookieの値を返します。
// https://stackoverflow.com/questions/5639346/what-is-the-shortest-function-for-reading-a-cookie-by-name-in-javascript
function getCookie(name: string) {
  return (document.cookie.match(
    "(?:^|;)\\s*" + name.trim() + "\\s*=\\s*([^;]*?)\\s*(?:;|$)"
  ) || [])[1];
}

// 個別レクチャーのデータURL
// パラメータを渡すかどうかは自由ですが、
// 引数を渡さなかった場合は、現在のレクチャーとして扱われます
function get_lecture_data_url(
  param_course_id: string = "",
  param_lecture_id: string = ""
) {
  // let course_id = '3681012'
  // let lecture_id = '23665120'
  // let example_url = `https://www.udemy.com/api-2.0/users/me/subscribed-courses/3681012/lectures/23665120/?fields[lecture]=asset,description,download_url,is_free,last_watched_second&fields[asset]=asset_type,length,media_license_token,media_sources,captions,thumbnail_sprite,slides,slide_urls,download_urls`
  let course_id = param_course_id || get_args_course_id(); // HTMLから現在表示しているコースのcourseIdを取得
  let lecture_id = param_lecture_id || get_args_lecture_id(); // URLからlectureIdを取得
  let url = `https://www.udemy.com/api-2.0/users/me/subscribed-courses/${course_id}/lectures/${lecture_id}/?fields[lecture]=asset,description,download_url,is_free,last_watched_second&fields[asset]=asset_type,length,media_license_token,media_sources,captions,thumbnail_sprite,slides,slide_urls,download_urls`;
  return url;
}

// https://greasyfork.org/en/scripts/422576-udemy-subtitle-downloader-v3/discussions/110421
// このレクチャーのidを取得する
// function get_args_lecture_id() {
//   let json = get_args();
//   return json.initialCurriculumItemId;
// }
function get_args_lecture_id() {
  const result = /(?<=lecture\/)\d*/.exec(document.URL);
  if (!result) return;
  return result[0];
  // 以下の（？）方法では、
  // lecture_id は常にページを開いたときと同じレクチャーになり、
  // 他のサブレクチャーに切り替えても変更されません。
  // let json = get_args()
  // return json.initialCurriculumItemId
}

// コースIDを取得する
function get_args_course_id() {
  let json = get_args();
  return json.courseId;
}

// パラメータの取得
// HTMLのDOMのdata-module-args属性のJSONを返す
function get_args() {
  let ud_app_loader = document.querySelector(".ud-app-loader");
  if (!ud_app_loader || !(ud_app_loader as any).dataset)
    throw Error("ud_app_loader or ud_app_loader.dataset is null");
  let args = (ud_app_loader as any).dataset.moduleArgs;
  let json = JSON.parse(args);
  return json;
}

// idを入力
// そのセッションのタイトルに戻る
// await get_lecture_title_by_id(id)
async function get_lecture_title_by_id(id: string) {
  let data = await get_course_data();
  let lectures = data.results; // コース配下のレクチャー配列
  const foundLecture = lectures.find(
    (lecture: any) => lecture._class === "lecture" && lecture.id === id
  );
  if (foundLecture) {
    return `${foundLecture.object_index}. ${foundLecture.title}`;
  } else {
    throw Error("lectureIdが一致するレクチャーがコース内になかった");
  }
}

// コース全体のデータを取得する
// OK
function get_course_data(): any {
  return new Promise((resolve, reject) => {
    // Udemyでログイン済みのブラウザで実行していることが条件
    let access_token = getCookie("access_token");
    let bearer_token = `Bearer ${access_token}`;
    // get_course_data_url: Udemy apiからコース全体のデータURLを取得する
    fetch(get_course_data_url(), {
      headers: {
        "x-udemy-authorization": bearer_token,
        authorization: bearer_token,
      },
    })
      .then((response) => response.json())
      .then((data) => {
        resolve(data);
      })
      .catch((e) => {
        reject(e);
      });
  });
}

// コース全体のデータ URL
function get_course_data_url() {
  let course_id = get_args_course_id();
  // let example_url = "https://www.udemy.com/api-2.0/courses/3681012/subscriber-curriculum-items/?page_size=1400&fields[lecture]=title,object_index,is_published,sort_order,created,asset,supplementary_assets,is_free&fields[quiz]=title,object_index,is_published,sort_order,type&fields[practice]=title,object_index,is_published,sort_order&fields[chapter]=title,object_index,is_published,sort_order&fields[asset]=title,filename,asset_type,status,time_estimation,is_external&caching_intent=True"
  let url = `https://www.udemy.com/api-2.0/courses/${course_id}/subscriber-curriculum-items/?page_size=1400&fields[lecture]=title,object_index,is_published,sort_order,created,asset,supplementary_assets,is_free&fields[quiz]=title,object_index,is_published,sort_order,type&fields[practice]=title,object_index,is_published,sort_order&fields[chapter]=title,object_index,is_published,sort_order&fields[asset]=title,filename,asset_type,status,time_estimation,is_external&caching_intent=True`;
  return url;
}

// 安全なファイル名への変換
function safe_filename(string: string) {
  let s = string;
  s = s.replace(":", "-");
  s = s.replace("'", " ");
  return s;
}

// vttを保存
// パラメータ：urlはvttファイルのURL、urlにアクセスするとファイルの内容が表示されるはずです。
// filenameは保存するファイルの名前です
function save_vtt(url: string, filename: string) {
  fetch(url, {})
    .then((response) => response.text())
    .then((data) => {
      downloadString(data, "text/plain", filename);
    })
    .catch((e) => {
      console.log(e);
    });
}

// copy from: https://gist.github.com/danallison/3ec9d5314788b337b682
// Example downloadString(srt, "text/plain", filename);
function downloadString(
  text: string | Blob,
  fileType: string, // application/x-mpegURL
  fileName: string
) {
  // Blobとは、BLOB（Binary Large Object）を扱うためJavaScriptのオブジェクトです。
  // BlobによってJSでバイナリデータを扱うことが出来る
  // new Blob(【ファイルの内容の配列】,【ファイルの種類（MIMEタイプ）】);
  let blob = new Blob([text], {
    type: fileType,
  });
  let a = document.createElement("a");
  a.download = fileName;
  a.href = URL.createObjectURL(blob);
  a.dataset.downloadurl = [fileType, a.download, a.href].join(":");
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () {
    URL.revokeObjectURL(a.href);
  }, 11500);
}

// ビデオの数を整数で返します。
async function get_course_lecture_number() {
  // get_course_data: コース全体のデータを取得する
  let data = await get_course_data();
  let array = data.results;
  let num = 0;
  for (let i = 0; i < array.length; i++) {
    const r = array[i];
    if (r._class == "lecture") {
      num += 1;
    }
  }
  return num;
}

const translate_current_lecture = async () => {
  // 現在のページのレクチャーの字幕情報を取得する
  const getEnglishSubtitlesInfoForCurrentLecture = async () => {
    // chrome.devtools.network等から字幕データのURLを取得する
    let dom = null;
    while (!dom) {
      // コースIDを取得するために必要なDOM（get_args関数内で使用するDOM）が描画されるまで待機
      dom = document.querySelector(".ud-app-loader");
      await sleep(250);
    }
    const data = await get_lecture_data(); // 現在のレクチャーのデータを取得する（引数を渡さなかった（空文字の）場合は、現在のレクチャーを取得）
    const lecture_id_from_fetched_data = data.id; // 取得したレクチャーデータから、このレクチャーのidを取得する
    const lecture_title = await get_lecture_title_by_id(
      lecture_id_from_fetched_data
    ); // レクチャーidでレクチャータイトルを検索する

    // 複数の言語の字幕データが入ってくるので、data.asset.captions.lengthが1以上になることもある
    const captions_en = data.asset.captions.find(
      (caption: any) => caption.video_label === "英語"
    );
    const captions_en_auto = data.asset.captions.find(
      (caption: any) => caption.video_label === "英語 [自動]"
    );
    if (!lecture_title) throw Error("lecture_title is null");
    // if (!captions_en) return; // 文字のみのレクチャー or 英語字幕がないレクチャーはここで返す
    return captions_en ? captions_en : captions_en_auto;
  };

  // 現在のページのレクチャーのvttデータを取得する
  const getCurrentLectureVtt = async (captions_en: any) => {
    const subtitleUrl = captions_en.url;

    // 字幕データのURLから字幕データを取得する
    const response = await fetch(subtitleUrl, {
      headers: {
        accept: "application/json, text/plain, */*",
        "accept-language": "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7",
        "referrer-policy": "strict-origin-when-cross-origin",
        "sec-ch-ua":
          '" Not A;Brand";v="99", "Chromium";v="96", "Google Chrome";v="96"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Linux"',
      },
      referrer: "https://www.udemy.com/",
      referrerPolicy: "strict-origin-when-cross-origin",
      body: null,
      method: "GET",
      mode: "cors",
      credentials: "omit",
    });
    const reader = response.body?.getReader();
    let vtt = "";
    while (true) {
      if (!reader) continue;
      const result = await reader.read();
      if (result.done) {
        break;
      } else {
        const decoder = new TextDecoder();
        vtt += decoder.decode(result.value);
      }
    }
    return vtt;
  };

  // Storage or getCurrentLectureVtt + translate_vtt_data で日本語の構造化されたvttを取得する
  const getJapaneseStructuredVtt = async (captions_en: any) => {
    // Cloud StorageにJSONがあるか問い合わせる
    const jsonRef = ref(
      storage,
      `ja/${get_args_course_id()}/${get_args_lecture_id()}.json`
    );
    let translatedSentences: Sentence[] | null = null;
    try {
      // JSONから翻訳データを取得する
      const url = await getDownloadURL(jsonRef);
      translatedSentences = await fetch(url).then((res) => res.json());
    } catch {
      // JSONがない
      const vtt = await getCurrentLectureVtt(captions_en);
      if (!vtt) throw Error("vttデータの取得に失敗");
      translatedSentences = await translate_vtt_data(vtt);
    }
    return translatedSentences;
  };

  // 現在のレクチャーの要素を取得して返す
  // 字幕のコンテナの一つ上 aria-label="Video Player"
  const getCurrentLectureVideoContainer = async () => {
    let subtitleWrapperWrapper = null;
    while (!subtitleWrapperWrapper) {
      subtitleWrapperWrapper = document.querySelector(
        '[aria-label="Video Player"]'
      );
      await sleep(500);
    }
    const htmlCollections = Array.from(subtitleWrapperWrapper.children);
    const videoElem = htmlCollections[0];
    const subtitleWrapper = htmlCollections[htmlCollections.length - 1];
    return [videoElem, subtitleWrapper];
  };

  // 取得した要素に字幕表示用のDOMを追加する
  const insertDivElementToElement = (parentElement: Node) => {
    const div_css = `
    margin-bottom: 10px;
    display: flex;
    background-color: #333;
    opacity: 0.75;
    font-size: 24px;
    padding: 0px 20px;
  `;
    const subtitle_div = document.createElement("div");
    subtitle_div.setAttribute("style", div_css);
    parentElement.appendChild(subtitle_div);

    return subtitle_div;
  };

  const displaySubtitlesBasedOnCurrentTime = (
    videoElem: any,
    subtitle_div: Node,
    translatedSentences: Sentence[]
  ) => {
    // 直近のcurrentTimeと一致したsentenceFromToを控えておく
    let sentenceFromTo: Sentence | undefined;
    // currentTimeが渡されたsentenceFromToの範囲内にあるか調べる
    const checkCurrentTimeWithinRange = (
      currentTime: number,
      sentenceFromTo: Sentence
    ) => {
      return (
        currentTime > timeToNumber(sentenceFromTo.from).time_number &&
        currentTime < timeToNumber(sentenceFromTo.to).time_number
      );
    };
    // 字幕表示用のDOMのtextContentを変更する
    const setSubtitleIntoTextContent = (
      videoElement: any,
      translatedSentences: Sentence[]
    ) => {
      const currentTime = (videoElement as any).currentTime;
      // 前回一致した範囲内にcurrentTimeが、ある場合はリターン
      if (
        sentenceFromTo &&
        checkCurrentTimeWithinRange(currentTime, sentenceFromTo)
      )
        return;
      sentenceFromTo = translatedSentences.find((ts: Sentence) =>
        checkCurrentTimeWithinRange(currentTime, ts)
      );
      if (sentenceFromTo && sentenceFromTo.sentence_ja) {
        subtitle_div.textContent = sentenceFromTo.sentence_ja;
      } else {
        subtitle_div.textContent = "";
      }
    };
    // 初回の字幕表示
    setSubtitleIntoTextContent(videoElem, translatedSentences);
    // 動画の再生時間が変化するたびに字幕表示を行う関数を実行する
    videoElem.addEventListener("timeupdate", () => {
      setSubtitleIntoTextContent(videoElem, translatedSentences);
    });
  };

  const displayJapaneseSubtitlesForVideo = async () => {
    const captions_en = await getEnglishSubtitlesInfoForCurrentLecture();
    if (!captions_en) return;
    const translatedSentences = await getJapaneseStructuredVtt(captions_en);
    if (!translatedSentences) throw Error("日本語字幕データの取得に失敗");
    const [videoElem, subtitleWrapper] =
      await getCurrentLectureVideoContainer();
    const subtitle_div = insertDivElementToElement(subtitleWrapper);
    displaySubtitlesBasedOnCurrentTime(
      videoElem,
      subtitle_div,
      translatedSentences
    );
  };

  console.log("calling displayJapaneseSubtitlesForVideo()");
  await displayJapaneseSubtitlesForVideo();
  // displayJapaneseSubtitlesForVideoを短いスパンで連続して呼ぶのを防止する
  let lastCallDisplayJapaneseSubtitlesForVideoMethodTime = new Date();

  let videoId = "";
  const observer = new MutationObserver(async function (mutationsList) {
    for (const mutation of mutationsList) {
      const addedNodes = mutation.addedNodes;
      if (addedNodes.length !== 1) return;
      const addedNodeId = (addedNodes[0] as any).id;
      if (
        addedNodes.length === 1 &&
        isString((addedNodes[0] as any)?.id) &&
        addedNodeId.indexOf("playerId") !== -1
      ) {
        if (videoId === addedNodeId) return;
        videoId = addedNodeId;
        // new Date().getTime() [ms]
        if (
          new Date().getTime() -
            lastCallDisplayJapaneseSubtitlesForVideoMethodTime.getTime() <
          500
        ) {
          throw Error("大量のリクエストを送信しようとしている可能性がある");
        }
        console.log("calling displayJapaneseSubtitlesForVideo()");
        await displayJapaneseSubtitlesForVideo();
        lastCallDisplayJapaneseSubtitlesForVideoMethodTime = new Date();
      }
    }
  });
  observer.observe(document, { childList: true, subtree: true });
  console.log("active Observer");
};

// テキスト形式のvttを{ from, to, sentence }型の構造化されたものに変換する
const convertToStructuredVtt = (vtt: string) => {
  const subtitleSplitByLine = vtt
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && line !== "\r");
  // WEBVTTの文言を削除
  const subtitleSplitByLineAndRemovedEmptyChar = subtitleSplitByLine.slice(
    1,
    subtitleSplitByLine.length
  );

  // timestamp上にindex番号がある場合、除去する
  let sentenceAndTimestampList = [];
  if (Number.isInteger(Number(subtitleSplitByLineAndRemovedEmptyChar[0]))) {
    // timestampの上にindexが存在するタイプのvtt
    sentenceAndTimestampList = subtitleSplitByLineAndRemovedEmptyChar.filter(
      (line, index) => index % 3 !== 0
    );
  } else {
    sentenceAndTimestampList = subtitleSplitByLineAndRemovedEmptyChar;
  }

  // 改行された文を結合する
  const isTimestamp = (text: string) => text.indexOf(" --> ") !== -1;
  const mergedNewlineSentences: string[] = [];
  let text = "";
  sentenceAndTimestampList.forEach((line, index) => {
    const isTimeStamp = isTimestamp(line);
    if (isTimeStamp) {
      if (text) {
        mergedNewlineSentences.push(text.trim());
        text = "";
      }
      mergedNewlineSentences.push(line);
    } else {
      text += `${line} `;
      if (sentenceAndTimestampList.length === index + 1) {
        // 最後の要素なのでtextをmergedNewlineSentencesにpushする
        mergedNewlineSentences.push(text.trim());
        text = "";
      }
    }
  });

  // { from, to, sentence }に構造化する
  const subtitles_array: Subtitle[] = [];
  for (let i = 0; i < mergedNewlineSentences.length / 2; i++) {
    const timeAndSubtitle = mergedNewlineSentences.slice(i * 2, i * 2 + 2);
    const time = timeAndSubtitle[0];
    const subtitle = removeTag(timeAndSubtitle[1]).replace("\r", "");
    const fromTo = time.split(" --> ");
    const from = fromTo[0];
    const to = removeLineChar(fromTo[1]).replace("\r", "");
    subtitles_array.push({
      from,
      to,
      subtitle,
    });
  }

  // { from, to, sentence } を纏まりのある文章になるようグルーピングする
  let sentence_array: Subtitle[] = [];
  const sentences_array: Subtitle[][] = [];
  subtitles_array.forEach((subtitle_array) => {
    const endChar = subtitle_array.subtitle[subtitle_array.subtitle.length - 1];
    if (endChar === "." || endChar === "?" || endChar === ")") {
      // 文末がピリオド or ?
      sentence_array.push(subtitle_array);
      sentences_array.push(sentence_array);
      sentence_array = [];
    } else {
      // 文の途中
      sentence_array.push(subtitle_array);
    }
  });

  // グルーピングしたオブジェクト配列を結合する
  const arrayPerSentence: Sentence[] = [];
  sentences_array.forEach((sentenceArray) => {
    let sentence = "";
    sentenceArray.forEach((subtitleAndFromTo) => {
      // 結合の際、スペース開ける必要があるのでは?
      sentence += ` ${subtitleAndFromTo.subtitle}`;
    });
    sentence = sentence.trim();
    if (sentenceArray.length === 1) {
      // 一つで完結した字幕
      arrayPerSentence.push({
        from: sentenceArray[0].from,
        to: sentenceArray[0].to,
        sentence_en: sentence,
      });
    } else {
      const firstTime_string = sentenceArray[0].from;
      const endTime_string = sentenceArray[sentenceArray.length - 1].to;
      arrayPerSentence.push({
        from: firstTime_string,
        to: endTime_string,
        sentence_en: sentence,
      });
    }
  });

  return arrayPerSentence;
};

const translate_vtt_data = async (
  structuredVtt: any,
  courseId: string = "",
  lectureId: string = ""
) => {
  // Cloud StorageにJSONがあるか問い合わせる
  const cid = courseId || get_args_course_id();
  const lid = lectureId || get_args_lecture_id();
  const jsonRef = ref(storage, `ja/${cid}/${lid}.json`);

  let translatedStructuredVtt = null;
  try {
    // JSONから翻訳データを取得する
    const url = await getDownloadURL(jsonRef);
    translatedStructuredVtt = await fetch(url).then((res) => res.json());
  } catch (error: any) {
    if (error.message.indexOf("storage/object-not-found") === -1) {
      // JSONが存在しないこと以外のエラー
      console.log(`JSONが存在しないこと以外のエラー: ja/${cid}/${lid}.json`);
      throw Error(error);
    } else {
      translatedStructuredVtt = await translate_text_by_deepl_website(
        structuredVtt
      );
      if (translatedStructuredVtt.length !== structuredVtt.length)
        throw Error("英 => 日で文章の対応関係が正しくない");

      // 翻訳後の構造化されたvttが正しく翻訳できているかチェックするのに使う
      // 一つでもsentenceがfalsyなのがあればアウト
      if (
        translatedStructuredVtt.some(
          (ts: Sentence) => !ts.sentence_en || !ts.sentence_ja
        )
      ) {
        console.log("translatedStructuredVtt", translatedStructuredVtt);
        console.log(`origin vtt: en/${cid}/${lid}.json`);
        throw Error("翻訳されたvttのフォーマットが正しくない");
      }
      await sleep(1000);

      // Cloud StorageにJSONを保存
      const json = JSON.stringify(translatedStructuredVtt);
      const blob = new Blob([json], { type: "application/json" });
      await uploadBytes(jsonRef, blob);
      console.log("Uploaded a blob or file!");
    }
  }

  return translatedStructuredVtt;
};

const translate_text_by_deepl_website = async (
  data: Sentence[]
): Promise<Sentence[]> => {
  const res = await axios.post(`http://localhost:3000/api/translate`, {
    data,
  });
  return res.data.translatedSentences;
};

const get_all_vtt_data_and_upload_storage = async () => {
  const course_id = get_args_course_id(); // URLからコースIDを取得
  const data = await get_course_data(); // URLから取得したコースIDとCookieから取得した認証情報を元にコース全体のデータを取得する
  const array = data.results.filter(
    (result: any) => result._class === "lecture"
  ); // chapter, lecture等が入った配列
  await sleep(1000);
  for await (const result of array) {
    const lecture_id = result.id;
    // 引数を渡さなかった（空文字の）場合は、現在のレクチャーとして扱われます
    const data = await get_lecture_data(course_id, lecture_id); // 現在のレクチャーのデータを取得する
    await sleep(1000);

    const lecture_id_from_fetched_data = data.id; // 取得したレクチャーデータから、このレクチャーのidを取得する
    const lecture_title = await get_lecture_title_by_id(
      lecture_id_from_fetched_data
    ); // レクチャーidでレクチャータイトルを検索する
    await sleep(1000);

    // 複数の言語の字幕データが入ってくるので、data.asset.captions.lengthが1以上になることもある
    const captions_en = data.asset.captions.find(
      (caption: any) => caption.video_label === "英語"
    );
    const captions_en_auto = data.asset.captions.find(
      (caption: any) => caption.video_label === "英語 [自動]"
    );
    if (
      (!captions_en || !captions_en.url) &&
      (!captions_en_auto || !captions_en_auto.url)
    ) {
      // 英語字幕が存在しないレクチャー
      continue;
    }

    console.log(lecture_title, "\n", `en/${course_id}/${lecture_id}.json`);

    // 字幕データのダウンロード
    const url = captions_en?.url || captions_en_auto?.url;
    const response = await fetch(url);
    const reader = response.body?.getReader();
    let vtt = "";
    while (true) {
      if (!reader) continue;
      const result = await reader.read();
      if (result.done) {
        break;
      } else {
        const decoder = new TextDecoder();
        vtt += decoder.decode(result.value);
      }
      await sleep(250);
    }
    const structuredVtt = convertToStructuredVtt(vtt);
    // バリデーション
    structuredVtt.forEach(({ from, to, sentence_en }) => {
      const isOk =
        (from.match(/^\d{2}\:\d{2}\:\d{2}\.\d{3}$/) ||
          from.match(/^\d{2}\:\d{2}\.\d{3}$/)) &&
        (to.match(/^\d{2}\:\d{2}\:\d{2}\.\d{3}$/) ||
          to.match(/^\d{2}\:\d{2}\.\d{3}$/)) &&
        sentence_en &&
        isString(sentence_en);
      if (!isOk) {
        console.log("該当箇所", { from, to, sentence_en });
        console.log("structuredVtt", structuredVtt);
        throw Error("正しくvttを構造化出来ていない");
      } else return isOk;
    });

    // storageに保存
    const jsonRef = ref(storage, `en/${course_id}/${lecture_id}.json`);
    const json = JSON.stringify(structuredVtt);
    const blob = new Blob([json], { type: "application/json" });
    await uploadBytes(jsonRef, blob);
    console.log("Uploaded a blob or file!");
  }
};

const translate_all_vtt_data = async () => {
  const course_id = get_args_course_id(); // URLからコースIDを取得
  const course_data = await get_course_data(); // URLから取得したコースIDとCookieから取得した認証情報を元にコース全体のデータを取得する
  const videoLectures = course_data.results.filter(
    (result: any) =>
      result._class === "lecture" && result.asset.asset_type === "Video"
  ); // video形式のレクチャー情報のみ取り出す

  const listRef = ref(storage, `ja/${course_id}`);
  const translatedLectureIds = await listAll(listRef)
    .then((res) => {
      const lectureIds: number[] = [];
      res.items.forEach((itemRef) => {
        lectureIds.push(Number(itemRef.name.replace(/\.[^/.]+$/, "")));
      });
      return lectureIds;
    })
    .catch((error) => {
      throw Error(error);
    });
  const restOfLectures = videoLectures.filter(
    (lecture: any) => !translatedLectureIds.includes(lecture.id)
  );
  await sleep(1000);
  for await (const result of restOfLectures) {
    const lecture_id = result.id;
    // 引数を渡さなかった（空文字の）場合は、現在のレクチャーとして扱われます
    const data = await get_lecture_data(course_id, lecture_id);
    await sleep(1000);

    // 英語字幕が存在しないレクチャーはスキップする
    const captions_en = data.asset.captions.find(
      (caption: any) => caption.video_label === "英語"
    );
    const captions_en_auto = data.asset.captions.find(
      (caption: any) => caption.video_label === "英語 [自動]"
    );
    if (
      (!captions_en || !captions_en.url) &&
      (!captions_en_auto || !captions_en_auto.url)
    ) {
      // 英語字幕が存在しないレクチャー
      continue;
    }

    const jsonRef = ref(storage, `en/${course_id}/${lecture_id}.json`);
    let structuredVtt = null;
    try {
      // JSONから翻訳データを取得する
      const url = await getDownloadURL(jsonRef);
      structuredVtt = await fetch(url).then((res) => res.json());
    } catch (error: any) {
      throw Error(error);
    }

    const lecture_id_from_fetched_data = data.id; // 取得したレクチャーデータから、このレクチャーのidを取得する
    const lecture_title = await get_lecture_title_by_id(
      lecture_id_from_fetched_data
    ); // レクチャーidでレクチャータイトルを検索する
    await sleep(1000);
    console.log(`${lecture_title}の字幕データを日本語に翻訳する`);
    await translate_vtt_data(structuredVtt, course_id, lecture_id);
    sleep(1000);
  }
};

// inject_our_script();

translate_current_lecture();

// translate_all_vtt_data();

// get_all_vtt_data_and_upload_storage();
