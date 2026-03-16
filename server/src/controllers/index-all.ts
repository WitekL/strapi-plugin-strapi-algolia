import type { Core, UID } from '@strapi/strapi';
import Koa from 'koa';
import { StrapiAlgoliaConfig } from '../../../utils/config';

const BATCH_SIZE = 200;

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async index(
    ctx: Koa.Context & {
      request: {
        body?: unknown;
        rawBody: string;
      };
    }
  ) {
    const {
      indexPrefix = '',
      contentTypes,
      applicationId,
      apiKey,
      transformerCallback,
    } = strapi.config.get(
      'plugin::strapi-algolia'
    ) as StrapiAlgoliaConfig;

    if (!contentTypes) {
      return;
    }

    const strapiAlgolia = strapi.plugin('strapi-algolia');
    const algoliaService = strapiAlgolia.service('algolia');
    const strapiService = strapiAlgolia.service('strapi');

    const client = await algoliaService.getAlgoliaClient(
      applicationId,
      apiKey
    );
    const body = ctx.request.body as any;

    if (!body.name) {
      return ctx.throw(400, `Missing name in body`);
    }

    const contentType = contentTypes.find(
      (contentType) => contentType.name === body.name
    );

    if (!contentType) {
      return ctx.throw(
        400,
        `Content type not found in config with ${body.name}`
      );
    }

    const {
      name,
      index,
      idPrefix = '',
      populate = '*',
      hideFields = [],
      transformToBooleanFields = [],
    } = contentType;

    const indexName = `${indexPrefix}${index ?? name}`;

    const allLocales =
      await strapi.plugins?.i18n?.services?.locales?.find();
    const localeFilter = allLocales?.map((locale: any) => locale.code);

    const baseFindManyOptions: any = { populate };
    if (localeFilter) {
      baseFindManyOptions.locale = localeFilter;
    }

    let totalProcessed = 0;
    const seenPublishedIds = new Set<string>();

    // Process published articles in batches
    let page = 0;
    for (;;) {
      const batch = await strapi
        .documents(name as UID.ContentType)
        .findMany({
          ...baseFindManyOptions,
          status: 'published',
          limit: BATCH_SIZE,
          offset: page * BATCH_SIZE,
        }) ?? [];

      if (!batch.length) break;

      // Track published IDs to filter drafts later
      batch.forEach((article: any) => seenPublishedIds.add(article.id));

      await strapiService.afterUpdateAndCreateAlreadyPopulate(
        body.name,
        batch,
        idPrefix,
        client,
        indexName,
        transformToBooleanFields,
        hideFields,
        transformerCallback
      );

      totalProcessed += batch.length;
      page += 1;
    }

    // Process draft articles (only those without published versions)
    page = 0;
    for (;;) {
      const batch = await strapi
        .documents(name as UID.ContentType)
        .findMany({
          ...baseFindManyOptions,
          status: 'draft',
          limit: BATCH_SIZE,
          offset: page * BATCH_SIZE,
        }) ?? [];

      if (!batch.length) break;

      // Filter out drafts that have published versions
      const draftsOnly = batch.filter(
        (draft: any) => !seenPublishedIds.has(draft.id)
      );

      if (draftsOnly.length > 0) {
        await strapiService.afterUpdateAndCreateAlreadyPopulate(
          body.name,
          draftsOnly,
          idPrefix,
          client,
          indexName,
          transformToBooleanFields,
          hideFields,
          transformerCallback
        );
        totalProcessed += draftsOnly.length;
      }

      page += 1;
    }

    return ctx.send({
      message: `Indexing articles type ${name} to index ${indexName} finished. Processed ${totalProcessed} records in batches of ${BATCH_SIZE}.`,
    });
  },
});
