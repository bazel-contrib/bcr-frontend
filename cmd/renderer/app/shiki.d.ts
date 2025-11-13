interface Window {
    codeToHtml(
        code: string,
        options: {
            lang: string;
            theme: string;
        }
    ): Promise<string>;
}
