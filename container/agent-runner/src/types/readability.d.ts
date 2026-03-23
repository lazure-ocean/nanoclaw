declare module '@mozilla/readability' {
  interface ReadabilityArticle {
    title: string;
    content: string;
    textContent: string;
    length: number;
    excerpt: string;
    byline: string;
    dir: string;
    siteName: string;
    lang: string;
    publishedTime: string;
  }

  class Readability {
    constructor(document: Document, options?: Record<string, unknown>);
    parse(): ReadabilityArticle | null;
  }

  export { Readability, ReadabilityArticle };
}
